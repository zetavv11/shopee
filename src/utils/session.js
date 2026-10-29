'use strict';

/**
 * Utilitas sesi Partner Portal (cookie / JWT / cURL DevTools).
 *
 * Fakta dari riset repo komunitas (belum ada dokumentasi resmi):
 *  - Cookie login portal bernama `__shopee_partner_website_x_token_live` berisi JWT.
 *    Payload JWT memuat token internal berawalan "B:" (plus userid dan exp).
 *  - Token "B:..." itulah yang dikirim di body request: data.metadata.token.
 *  - Cookie sesi lain di domain yang sama ikut dikirim browser lewat header Cookie.
 * Semua fungsi di sini murni (tanpa jaringan) dan tidak pernah mencetak nilai rahasia.
 */

const TOKEN_COOKIE_NAME = '__shopee_partner_website_x_token_live';

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

/** Parse string header Cookie ("a=1; b=2") menjadi object. */
function parseCookieHeader(str) {
  const out = {};
  if (typeof str !== 'string') return out;
  for (const part of str.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

function decodeJwtPayload(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.trim().split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (_) {
    return null;
  }
}

/** Cari string berawalan "B:" di mana pun di dalam object (nama field tidak terdokumentasi). */
function findInnerToken(node, depth = 0) {
  if (depth > 5 || node === null || node === undefined) return null;
  if (typeof node === 'string') return /^B:\S{10,}$/.test(node) ? node : null;
  if (typeof node !== 'object') return null;
  for (const v of Object.values(node)) {
    const found = findInnerToken(v, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Terima: token "B:..." langsung, JWT cookie, "name=value", atau header Cookie lengkap.
 * Kembalikan { token, cookieHeader, expiresAt, source } (field bisa null).
 */
function parseCredential(input) {
  const raw = typeof input === 'string' ? input.trim().replace(/^cookie:\s*/i, '') : '';
  const result = { token: null, cookieHeader: null, expiresAt: null, source: null };
  if (!raw) return result;

  // 1) Token B: langsung.
  if (/^B:\S{10,}$/.test(raw)) {
    result.token = raw;
    result.source = 'token';
    return result;
  }

  // 2) Header Cookie lengkap atau "name=value".
  let jwt = null;
  if (raw.includes('=') && !/^eyJ/.test(raw)) {
    const cookies = parseCookieHeader(raw);
    const names = Object.keys(cookies);
    if (names.length) {
      result.cookieHeader = names.map((n) => `${n}=${cookies[n]}`).join('; ');
      result.source = 'cookie';
      jwt = cookies[TOKEN_COOKIE_NAME] ? safeDecode(cookies[TOKEN_COOKIE_NAME]) : null;
      if (!jwt) {
        // Cari JWT di cookie mana pun bila nama berbeda.
        for (const v of Object.values(cookies)) {
          const d = safeDecode(v);
          if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(d)) {
            jwt = d;
            break;
          }
        }
      }
    }
  } else {
    // 3) Nilai cookie saja (JWT).
    jwt = safeDecode(raw);
    result.source = 'jwt';
    result.cookieHeader = `${TOKEN_COOKIE_NAME}=${raw}`;
  }

  if (jwt) {
    const payload = decodeJwtPayload(jwt);
    if (payload) {
      result.token = findInnerToken(payload);
      const exp = Number(payload.exp);
      if (Number.isFinite(exp) && exp > 1e9) result.expiresAt = new Date(exp * 1000);
    }
  }
  return result;
}

// --------------------------- cURL (Copy as cURL) ---------------------------

/** Tokenizer shell sederhana: kutip tunggal/ganda, $'...' , backslash-newline. */
function shellSplit(input) {
  const s = String(input).replace(/\\\r?\n/g, ' ');
  const out = [];
  let cur = '';
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || (c === '$' && s[i + 1] === "'")) {
      const ansi = c === '$';
      if (ansi) i++;
      i++;
      while (i < s.length && s[i] !== "'") {
        if (ansi && s[i] === '\\' && i + 1 < s.length) {
          const n = s[i + 1];
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };
          cur += map[n] !== undefined ? map[n] : n;
          i += 2;
          continue;
        }
        cur += s[i++];
      }
      has = true;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) {
          cur += s[i + 1];
          i += 2;
          continue;
        }
        cur += s[i++];
      }
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/**
 * Parse hasil "Copy as cURL (bash)" dari DevTools request get-transaction-list.
 * Kembalikan { url, method, headers, cookieHeader, body, bodyJson }.
 */
function parseCurl(curlText) {
  const args = shellSplit(curlText);
  if (!args.length || !/^curl$/i.test(args[0])) throw new Error('Teks harus diawali "curl" (hasil Copy as cURL (bash)).');

  const out = { url: null, method: null, headers: {}, cookieHeader: null, body: null, bodyJson: null };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    if (a === '-H' || a === '--header') {
      const h = next() || '';
      const idx = h.indexOf(':');
      if (idx > 0) out.headers[h.slice(0, idx).trim().toLowerCase()] = h.slice(idx + 1).trim();
    } else if (a === '-b' || a === '--cookie') {
      out.cookieHeader = next();
    } else if (a === '-X' || a === '--request') {
      out.method = String(next() || '').toUpperCase();
    } else if (['--data', '--data-raw', '--data-binary', '--data-ascii', '-d'].includes(a)) {
      out.body = next();
    } else if (a === '--url') {
      out.url = next();
    } else if (/^https?:\/\//i.test(a)) {
      out.url = a;
    } else if (['-A', '--user-agent'].includes(a)) {
      out.headers['user-agent'] = next();
    } else if (['-e', '--referer'].includes(a)) {
      out.headers.referer = next();
    }
  }
  if (!out.cookieHeader && out.headers.cookie) out.cookieHeader = out.headers.cookie;
  delete out.headers.cookie;
  if (out.body) {
    try {
      out.bodyJson = JSON.parse(out.body);
    } catch (_) {
      out.bodyJson = null;
    }
  }
  if (!out.method) out.method = out.body ? 'POST' : 'GET';
  if (!out.url) throw new Error('URL tidak ditemukan di cURL.');
  return out;
}

/** Ambil token dari body hasil capture: data.metadata.token. */
function tokenFromBody(bodyJson) {
  const t = bodyJson && bodyJson.data && bodyJson.data.metadata && bodyJson.data.metadata.token;
  return typeof t === 'string' && t ? t : null;
}

module.exports = {
  TOKEN_COOKIE_NAME,
  parseCookieHeader,
  parseCredential,
  decodeJwtPayload,
  findInnerToken,
  parseCurl,
  tokenFromBody,
  shellSplit,
};
