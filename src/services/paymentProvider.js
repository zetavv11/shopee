'use strict';

/**
 * Adapter provider pembayaran.
 *
 * Mode yang tersedia (dipilih otomatis dari konfigurasi):
 *  - createInvoice   : aktif bila QRIS_STATIC terisi -> payload QRIS statis disuntik nominal
 *                      (qris_kind = "static_injected"; BUKAN invoice dari provider).
 *  - getPaymentStatus / getTransactions / validateCredentials :
 *                      aktif bila ada kredensial sesi (SHOPEE_TOKEN dan/atau SHOPEE_COOKIE) dan
 *                      alamat endpoint (SHOPEE_TRANSACTIONS_URL, atau SHOPEE_API_BASE + path) -> membaca
 *                      daftar mutasi Partner Portal memakai sesi login merchant (tidak resmi).
 *  - verifyWebhook   : belum didukung (signature webhook ShopeePay tidak terdokumentasi).
 *
 * Bila komponen tidak dikonfigurasi, method melempar ProviderError('NOT_CONFIGURED').
 */

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { injectAmount, QrisError } = require('../utils/qris');
const session = require('../utils/session');

class ProviderError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
}

const PROVIDER_NAME = 'shopee-session';
const VALIDATION_CACHE_MS = 5 * 60 * 1000;
const FORWARD_HEADERS = ['user-agent', 'accept-language', 'origin', 'referer'];
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Kode error dari respons portal (hasil riset komunitas, belum ada dokumentasi resmi).
const TOKEN_DEAD_CODES = new Set(['200020', '2010000', '48500102', '48401003']);

const state = {
  token: '',
  cookieHeader: '',
  expiresAt: null, // dari klaim exp pada JWT cookie (hanya petunjuk, bukan bukti)
  listUrl: config.shopeeListUrl,
  headers: {}, // header hasil capture cURL (hanya yang di-allowlist)
  template: null, // body hasil capture cURL (dipakai sebagai kerangka payload)
  validation: null, // { state, message, checkedAt }
  diagnostics: null, // ringkasan respons terakhir tanpa nilai rahasia
};

function applyCredential(input) {
  const c = session.parseCredential(input);
  if (c.token) state.token = c.token;
  if (c.cookieHeader) state.cookieHeader = c.cookieHeader;
  if (c.expiresAt) state.expiresAt = c.expiresAt;
  logger.addSecret(c.token);
  logger.addSecret(c.cookieHeader);
  for (const v of Object.values(session.parseCookieHeader(c.cookieHeader || ''))) logger.addSecret(v);
  return c;
}

// Nilai awal dari environment.
if (config.shopeeToken) applyCredential(config.shopeeToken);
if (config.shopeeCookie) applyCredential(config.shopeeCookie);

const http = axios.create({
  timeout: config.providerTimeoutMs,
  maxRedirects: 0,
  maxContentLength: 2 * 1024 * 1024,
  validateStatus: () => true,
  responseType: 'json',
  transformResponse: [
    (data) => {
      if (typeof data !== 'string') return data;
      try {
        return JSON.parse(data);
      } catch (_) {
        return data; // bukan JSON (mis. halaman login HTML)
      }
    },
  ],
});

// ============================================================================
// BLOK TERGANTUNG-CAPTURE
// ----------------------------------------------------------------------------
// Terverifikasi dari riset repo komunitas (bukan dokumentasi resmi):
//   * token ada di body request: data.metadata.token (token "B:..." = isi JWT cookie
//     __shopee_partner_website_x_token_live)
//   * paginasi memakai cursor `next_position`; pageSize dibatasi kecil (praktik: maks 10)
//   * filter waktu epoch DETIK, serviceList [1, 3]
//   * nominal berupa string rupiah bertitik ribuan: "409.662" = Rp409.662 (BUKAN sen)
//   * status sukses = angka 3
//   * id transaksi: transactionId / displayTransactionId
//   * daftar mutasi bisa tertunda beberapa menit (indexing)
// Nama field lain dibuat toleran (beberapa kandidat). Bila tetap tidak cocok, panggil
// GET /token-status: bagian `diagnostics` menampilkan NAMA field respons (tanpa nilai).
// ============================================================================

const toEpochSeconds = (d) => Math.floor(d.getTime() / 1000);

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function buildListPayload(token, { limit, startDate, endDate, cursor }) {
  const base = state.template
    ? clone(state.template)
    : {
        data: {
          metadata: { language: 'id', timezone: 'Asia/Jakarta' },
          filter: { serviceList: [1, 3] },
          sorter: { field: 'createTime', order: 'descend' },
        },
      };
  const d = (base.data = base.data || {});
  d.metadata = Object.assign({}, d.metadata, { token: token || '' });
  d.pageSize = limit;
  d.filter = Object.assign({}, d.filter, {
    startTime: toEpochSeconds(startDate),
    endTime: toEpochSeconds(endDate),
  });
  d.next_position = cursor || '';
  return base;
}

function pick(obj, names) {
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null && obj[n] !== '') return obj[n];
  }
  return undefined;
}

function nextCursorOf(body) {
  const d = (body && body.data) || {};
  const c = pick(d, ['next_position', 'nextPosition', 'next_cursor', 'nextCursor', 'cursor']) ??
    (body && pick(body, ['next_position', 'nextPosition']));
  return c === undefined || c === null || c === '' || c === 0 ? null : String(c);
}

/** Cari array transaksi: kandidat nama dikenal dulu, lalu array of object pertama di dalam data. */
function extractList(body) {
  if (!body || typeof body !== 'object') return null;
  const d = body.data;
  const named = ['transactions', 'transaction_list', 'transactionList', 'list', 'records', 'items', 'results'];
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') {
    for (const n of named) if (Array.isArray(d[n])) return d[n];
    for (const v of Object.values(d)) {
      if (Array.isArray(v) && (v.length === 0 || (v[0] && typeof v[0] === 'object'))) return v;
    }
  }
  for (const n of named) if (Array.isArray(body[n])) return body[n];
  return null;
}

const SUCCESS_STATUS_TEXT = ['success', 'successful', 'completed', 'paid', 'settled', 'berhasil'];

function isSuccessStatus(v) {
  if (v === undefined || v === null || v === '') return false;
  if (typeof v === 'number') return v === 3;
  const s = String(v).trim().toLowerCase();
  return s === '3' || SUCCESS_STATUS_TEXT.includes(s);
}

function normalizeTransaction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = pick(raw, [
    'transactionId', 'transaction_id', 'displayTransactionId', 'display_transaction_id',
    'orderSn', 'order_sn', 'referenceNo', 'reference_no', 'id',
  ]);
  let rawAmount = pick(raw, [
    'amount', 'displayAmount', 'display_amount', 'transactionAmount', 'transaction_amount',
    'totalAmount', 'total_amount', 'paidAmount', 'paid_amount',
  ]);
  if (rawAmount && typeof rawAmount === 'object') rawAmount = pick(rawAmount, ['amount', 'value', 'displayAmount']);
  const amount = parseAmount(rawAmount);
  if (id === undefined || amount === null) return null;

  const rawStatus = pick(raw, ['status', 'transactionStatus', 'transaction_status', 'state']);
  return {
    id: String(id),
    displayId: String(pick(raw, ['displayTransactionId', 'display_transaction_id']) ?? id),
    amount,
    currency: 'IDR',
    status: rawStatus === undefined ? '' : String(rawStatus).toLowerCase(),
    success: isSuccessStatus(rawStatus),
    time: parseTime(
      pick(raw, [
        'createTime', 'create_time', 'transactionTime', 'transaction_time', 'paidTime', 'paid_time',
        'completeTime', 'complete_time', 'updateTime', 'update_time', 'time', 'createdAt', 'created_at',
      ])
    ),
    issuer: pick(raw, ['issuer', 'paymentMethod', 'payment_method', 'sourceOfFund']) ?? null,
  };
}
// ===================== AKHIR BLOK TERGANTUNG-CAPTURE ========================

/**
 * Nominal rupiah bulat. Menerima number bulat, "409.662", "Rp 409.662", "10.000,00", "10000".
 * Nominal negatif / berpecahan tidak dianggap (hanya pemasukan bulat yang dicocokkan).
 */
function parseAmount(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/^rp\.?\s*/i, '').replace(/^\+/, '').replace(/\s+/g, '');
  if (/,0{1,2}$/.test(s)) s = s.replace(/,0{1,2}$/, ''); // "10.000,00" -> "10.000"
  if (/^\d+$/.test(s)) return Number(s);
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ''));
  if (/^\d{1,3}(,\d{3})+$/.test(s)) return Number(s.replace(/,/g, ''));
  if (/^\d+\.0+$/.test(s)) return Number(s.split('.')[0]);
  return null;
}

function validDate(d) {
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseTime(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return validDate(new Date(v < 1e12 ? v * 1000 : v));
  const s = String(v).trim();
  if (/^\d{9,13}$/.test(s)) return parseTime(Number(s));
  // Format tanpa zona waktu ("YYYY-MM-DD HH:mm:ss") diasumsikan WIB (UTC+7).
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return validDate(new Date(s.replace(' ', 'T') + '+07:00'));
  }
  return validDate(new Date(s));
}

function listEndpoint() {
  if (state.listUrl) return state.listUrl;
  if (config.shopeeApiBase) return config.shopeeApiBase.replace(/\/+$/, '') + config.shopeeListPath;
  return '';
}

function hasCredential(token) {
  return Boolean(token || state.cookieHeader);
}

function hasSession(token) {
  return Boolean(hasCredential(token) && listEndpoint());
}

function notConfigured(message) {
  return new ProviderError('NOT_CONFIGURED', message, 501);
}

function buildHeaders(token) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
    Origin: config.shopeeOrigin,
    Referer: `${config.shopeeOrigin}/shopeepay-portal/transactions`,
    'User-Agent': config.shopeeUserAgent || DEFAULT_UA,
  };
  for (const [k, v] of Object.entries(state.headers)) {
    const name = k.replace(/(^|-)(\w)/g, (m, a, b) => a + b.toUpperCase());
    h[name] = v;
  }
  if (config.shopeeUserAgent) h['User-Agent'] = config.shopeeUserAgent;
  if (state.cookieHeader && !token) h.Cookie = state.cookieHeader;
  else if (state.cookieHeader) h.Cookie = state.cookieHeader;
  return h;
}

function summarize(body) {
  const keys = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).slice(0, 30) : undefined);
  const list = extractList(body);
  return {
    body_keys: keys(body),
    data_keys: keys(body && body.data),
    body_code: body && typeof body === 'object' ? body.code ?? body.error_code ?? (body.data && body.data.code) ?? null : null,
    list_found: Boolean(list),
    row_count: list ? list.length : 0,
    row_keys: list && list[0] && typeof list[0] === 'object' ? Object.keys(list[0]).slice(0, 40) : undefined,
    has_next_cursor: Boolean(nextCursorOf(body)),
  };
}

function noteDiag(extra) {
  state.diagnostics = Object.assign({ at: new Date().toISOString() }, extra);
}

function markInvalid(token, message) {
  if (token === state.token || !token) {
    state.validation = { state: 'INVALID', message, checkedAt: new Date() };
  }
}

async function postJson(payload, token) {
  const url = listEndpoint();
  let res;
  try {
    res = await http.post(url, payload, { headers: buildHeaders(token) });
  } catch (err) {
    noteDiag({ error: 'unreachable', net_code: err.code || null });
    logger.warn('Provider tidak dapat dihubungi', { code: err.code });
    throw new ProviderError('PROVIDER_UNREACHABLE', 'Provider tidak dapat dihubungi.', 502);
  }

  const ctype = String(res.headers['content-type'] || '').split(';')[0];
  const body = res.data;
  const isHtml = typeof body === 'string';
  noteDiag({ http_status: res.status, content_type: ctype, ...(isHtml ? { non_json: true } : summarize(body)) });

  // Redirect (mis. ke halaman login) = sesi tidak berlaku.
  if (res.status >= 300 && res.status < 400) {
    markInvalid(token, 'Provider mengalihkan ke halaman login: sesi tidak berlaku.');
    throw new ProviderError('PROVIDER_TOKEN_INVALID', 'Sesi ditolak (redirect ke login). Ambil token/cookie baru dari portal.', 502);
  }
  if (res.status === 401) {
    markInvalid(token, 'Provider menolak kredensial (401).');
    throw new ProviderError('PROVIDER_TOKEN_INVALID', 'Provider menolak token/cookie (HTTP 401).', 502);
  }
  if (res.status === 403) {
    // 403 TIDAK selalu berarti token salah: bisa juga IP datacenter (Render) diblokir anti-bot,
    // atau cookie pendamping tidak ikut terkirim.
    throw new ProviderError(
      'PROVIDER_FORBIDDEN',
      'Provider membalas HTTP 403. Penyebab umum: sesi/cookie kedaluwarsa, cookie pendamping belum ikut (isi SHOPEE_COOKIE lengkap), atau IP server diblokir anti-bot.',
      502
    );
  }
  if (res.status === 429) {
    throw new ProviderError('PROVIDER_RATE_LIMITED', 'Provider membatasi request (HTTP 429). Perlambat interval pemantauan.', 502);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ProviderError('PROVIDER_HTTP_ERROR', `Provider membalas HTTP ${res.status}.`, 502);
  }
  if (isHtml) {
    throw new ProviderError(
      'PROVIDER_NON_JSON',
      'Provider membalas non-JSON (kemungkinan halaman login/anti-bot). Periksa URL endpoint dan sesi.',
      502
    );
  }

  const code = body && (body.code ?? body.error_code ?? (body.data && body.data.code));
  if (code !== undefined && code !== null && TOKEN_DEAD_CODES.has(String(code))) {
    markInvalid(token, `Provider menolak sesi (kode ${code}).`);
    throw new ProviderError('PROVIDER_TOKEN_INVALID', `Provider menolak token/cookie (kode ${code}).`, 502);
  }
  return body;
}

async function fetchPage(token, { limit, startDate, endDate, cursor }) {
  const body = await postJson(buildListPayload(token, { limit, startDate, endDate, cursor }), token);
  const raw = extractList(body);
  if (!raw) {
    const code = body && (body.code ?? body.error_code);
    if (code !== undefined && code !== null && String(code) !== '0') {
      throw new ProviderError('PROVIDER_API_ERROR', `Provider membalas kode ${code} tanpa daftar transaksi.`, 502);
    }
    return { recognized: false, rows: [], next: null };
  }
  return { recognized: true, rows: raw, next: nextCursorOf(body) };
}

/**
 * Ambil mutasi dengan paginasi cursor (next_position) sampai habis / batas.
 * @param maxItems batas total baris yang dikembalikan
 */
async function fetchList(token, { limit = 50, startDate, endDate, maxPages = config.providerMaxPages }) {
  const pageSize = Math.min(config.providerPageSize, Math.max(1, limit));
  const rows = [];
  let cursor = '';
  const seen = new Set();
  let recognized = false;

  for (let page = 0; page < maxPages; page++) {
    const r = await fetchPage(token, { limit: pageSize, startDate, endDate, cursor });
    if (!r.recognized) {
      return { recognized: recognized, transactions: rows.map(normalizeTransaction).filter(Boolean) };
    }
    recognized = true;
    rows.push(...r.rows);
    if (rows.length >= limit) break;
    if (!r.next || seen.has(r.next) || r.rows.length === 0) break;
    seen.add(r.next);
    cursor = r.next;
    await new Promise((resolve) => setTimeout(resolve, 200)); // jeda sopan antar halaman
  }
  return { recognized, transactions: rows.slice(0, Math.max(limit, 0)).map(normalizeTransaction).filter(Boolean) };
}

// ----------------------------- Interface publik -----------------------------

function capabilities() {
  return {
    provider: PROVIDER_NAME,
    canCreateInvoice: Boolean(config.qrisStatic),
    canCheckPayment: hasSession(state.token),
    webhookSupported: false,
  };
}

/** Ringkasan konfigurasi sesi untuk /token-status (tanpa nilai rahasia). */
function sessionInfo() {
  return {
    has_token: Boolean(state.token),
    has_cookie: Boolean(state.cookieHeader),
    cookie_names: Object.keys(session.parseCookieHeader(state.cookieHeader)).slice(0, 20),
    endpoint_configured: Boolean(listEndpoint()),
    endpoint_host: (() => {
      try {
        return new URL(listEndpoint()).host;
      } catch (_) {
        return null;
      }
    })(),
    jwt_expires_at: state.expiresAt,
    jwt_expired: state.expiresAt ? state.expiresAt.getTime() < Date.now() : null,
    payload_template: Boolean(state.template),
  };
}

function diagnostics() {
  return state.diagnostics;
}

async function validateCredentials({ token } = {}) {
  const tk = token || state.token;
  if (!hasSession(tk)) {
    const missing = [];
    if (!hasCredential(tk)) missing.push('SHOPEE_TOKEN atau SHOPEE_COOKIE');
    if (!listEndpoint()) missing.push('SHOPEE_TRANSACTIONS_URL (atau SHOPEE_API_BASE)');
    return {
      state: 'NOT_CONFIGURED',
      message: `Belum diisi: ${missing.join(' dan ')}.`,
      checkedAt: new Date(),
    };
  }
  const cached = state.validation;
  if (!token && cached && Date.now() - cached.checkedAt.getTime() < VALIDATION_CACHE_MS) return cached;

  let result;
  try {
    const now = new Date();
    const r = await fetchList(tk, {
      limit: 1,
      startDate: new Date(now.getTime() - 24 * 3600 * 1000),
      endDate: now,
      maxPages: 1,
    });
    result = r.recognized
      ? {
          state: 'VALID',
          message: 'Provider menjawab permintaan dengan sesi ini (bukti uji langsung, bukan validasi resmi).',
        }
      : { state: 'UNVERIFIED', message: 'Provider menjawab, tetapi format respons tidak dikenali. Lihat bagian diagnostics.' };
  } catch (err) {
    result =
      err.code === 'PROVIDER_TOKEN_INVALID'
        ? { state: 'INVALID', message: err.message }
        : { state: 'UNVERIFIED', message: err.message, error_code: err.code };
  }
  result.checkedAt = new Date();
  if (!token) state.validation = result;
  return result;
}

async function createInvoice({ amount, orderId }) {
  if (!config.qrisStatic) {
    throw notConfigured('QRIS_STATIC belum diisi, pembuatan QRIS dinonaktifkan.');
  }
  try {
    return {
      providerInvoiceId: null, // tidak ada invoice di sisi provider pada mode ini
      qrisPayload: injectAmount(config.qrisStatic, amount),
      qrisKind: 'static_injected',
      expiresAt: new Date(Date.now() + config.invoiceTtlMinutes * 60 * 1000),
      orderId,
    };
  } catch (err) {
    if (err instanceof QrisError) throw new ProviderError(err.code, err.message, 500);
    throw err;
  }
}

/**
 * Mencari transaksi masuk yang cocok dengan invoice: status sukses, nominal sama persis,
 * waktu di antara pembuatan invoice (toleransi 60 detik) dan kedaluwarsa.
 * Pemeriksaan "sudah diklaim invoice lain" dilakukan pemanggil lewat constraint database.
 */
async function getPaymentStatus({ invoice, token }) {
  const tk = token || state.token;
  if (!hasSession(tk)) {
    throw notConfigured('Sesi Shopee (token/cookie) atau URL endpoint belum diisi, status pembayaran tidak dapat diverifikasi.');
  }
  if (!invoice) throw new ProviderError('INVALID_REQUEST', 'Data invoice diperlukan.', 500);

  const from = new Date(new Date(invoice.created_at).getTime() - 60 * 1000);
  const until = new Date(invoice.expires_at);
  const r = await fetchList(tk, { limit: 100, startDate: from, endDate: new Date() });
  if (!r.recognized) {
    throw new ProviderError('PROVIDER_UNRECOGNIZED_RESPONSE', 'Format respons provider tidak dikenali. Lihat diagnostics di GET /token-status.', 502);
  }

  const expected = Number(invoice.payable_amount);
  const matches = r.transactions.filter(
    (t) => t.success && t.amount === expected && t.time && t.time >= from && t.time <= until
  );
  return { state: matches.length ? 'PAID' : 'PENDING', matches };
}

async function getTransactions({ limit = 20, startDate, endDate, token, maxPages } = {}) {
  const tk = token || state.token;
  if (!hasSession(tk)) {
    throw notConfigured('Sesi Shopee (token/cookie) atau URL endpoint belum diisi.');
  }
  const end = endDate || new Date();
  const start = startDate || new Date(end.getTime() - 24 * 3600 * 1000);
  const r = await fetchList(tk, { limit, startDate: start, endDate: end, maxPages });
  if (!r.recognized) {
    throw new ProviderError('PROVIDER_UNRECOGNIZED_RESPONSE', 'Format respons provider tidak dikenali. Lihat diagnostics di GET /token-status.', 502);
  }
  return r.transactions;
}

/**
 * Signature webhook ShopeePay tidak terdokumentasi, jadi tidak ada validasi palsu di sini.
 * Selama belum ada dokumentasi resmi, hasilnya selalu { configured: false }.
 */
function verifyWebhook() {
  return {
    configured: false,
    valid: false,
    reason:
      'Verifikasi webhook belum dikonfigurasi: dokumentasi signature resmi ShopeePay diperlukan.',
  };
}

/** Ganti token "B:..." saja (kompatibel dengan POST /update-token lama). */
function setToken(newToken) {
  const c = applyCredential(newToken);
  if (!c.token && !c.cookieHeader) state.token = String(newToken).trim();
  state.validation = null;
  logger.addSecret(newToken);
  return { has_token: Boolean(state.token), has_cookie: Boolean(state.cookieHeader), expires_at: state.expiresAt };
}

/**
 * Ganti sesi di memori proses. Terima salah satu / kombinasi:
 *  - cookie : header Cookie lengkap, "name=value", atau nilai JWT cookie
 *  - token  : "B:..."
 *  - url    : URL lengkap get-transaction-list
 *  - curl   : teks "Copy as cURL (bash)" dari DevTools (mengisi url, cookie, token, header, kerangka payload)
 */
function setSession({ cookie, token, url, curl } = {}) {
  const applied = [];
  if (curl) {
    const c = session.parseCurl(curl);
    if (!/^https:\/\//i.test(c.url)) throw new ProviderError('INVALID_SESSION', 'URL pada cURL harus https://', 400);
    state.listUrl = c.url;
    applied.push('url');
    state.headers = {};
    for (const k of FORWARD_HEADERS) if (c.headers[k]) state.headers[k] = c.headers[k];
    if (c.bodyJson) {
      const t = clone(c.bodyJson);
      const embedded = session.tokenFromBody(t);
      if (embedded) {
        state.token = embedded;
        logger.addSecret(embedded);
        applied.push('token');
      }
      if (t.data && t.data.metadata) delete t.data.metadata.token; // jangan menyimpan token di template
      state.template = t;
      applied.push('payload_template');
    }
    if (c.cookieHeader) {
      applyCredential(c.cookieHeader);
      applied.push('cookie');
    }
  }
  if (url) {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) throw new ProviderError('INVALID_SESSION', 'url harus https://', 400);
    state.listUrl = url.trim();
    applied.push('url');
  }
  if (cookie) {
    const c = applyCredential(cookie);
    applied.push('cookie');
    if (c.token) applied.push('token_from_cookie');
  }
  if (token) {
    applyCredential(token);
    applied.push('token');
  }
  if (!applied.length) throw new ProviderError('INVALID_SESSION', 'Isi minimal salah satu: curl, cookie, token, url.', 400);
  state.validation = null;
  state.diagnostics = null;
  return { applied: [...new Set(applied)], session: sessionInfo() };
}

module.exports = {
  ProviderError,
  capabilities,
  sessionInfo,
  diagnostics,
  validateCredentials,
  createInvoice,
  getPaymentStatus,
  getTransactions,
  verifyWebhook,
  setToken,
  setSession,
  _internals: { parseAmount, parseTime, normalizeTransaction, extractList, nextCursorOf, isSuccessStatus, buildListPayload },
};
