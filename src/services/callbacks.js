'use strict';

/**
 * Callback keluar: setelah invoice benar-benar lunas, gateway mengirim POST bertanda tangan
 * ke CALLBACK_URL (website/bot kamu) agar produk langsung diberikan.
 * - Antrean tersimpan di database.json (callback_deliveries). Di Vercel berkas ini sementara (lihat README).
 * - Retry dengan backoff eksponensial sampai CALLBACK_MAX_ATTEMPTS, lalu FAILED + alert Telegram.
 * - Pengiriman bersifat at-least-once: penerima harus idempotent (pakai event_id/order_id).
 */

const axios = require('axios');
const config = require('../config');
const db = require('../database/db');
const logger = require('../utils/logger');
const telegram = require('./telegram');
const { buildHeader } = require('../utils/signature');

const http = axios.create({
  timeout: 10000,
  maxRedirects: 0,
  validateStatus: () => true,
  transformRequest: [(data) => data],
});

let timer = null;
let processing = false;

function enabled() {
  return Boolean(config.callbackUrl && config.callbackSecret);
}

async function claimDue(limit) {
  const now = Date.now();
  return db.transaction((d) => {
    const due = d.callback_deliveries
      .filter((c) => c.status === 'PENDING' && new Date(c.next_attempt_at).getTime() <= now)
      .sort((x, y) => new Date(x.next_attempt_at) - new Date(y.next_attempt_at))
      .slice(0, limit);
    for (const c of due) {
      c.next_attempt_at = new Date(now + 60 * 1000).toISOString();
      c.updated_at = new Date(now).toISOString();
    }
    return due.map((c) => structuredClone(c));
  });
}

function update(id, patch) {
  return db.transaction((d) => {
    const row = d.callback_deliveries.find((c) => c.id === id);
    if (row) Object.assign(row, patch, { updated_at: new Date().toISOString() });
  });
}

async function send(row) {
  const body = JSON.stringify(row.payload);
  try {
    const res = await http.post(config.callbackUrl, body, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'shopeepay-api-gateway/1.0',
        'X-Gateway-Event': row.event_type,
        'X-Gateway-Event-Id': row.payload.event_id,
        'X-Gateway-Signature': buildHeader(config.callbackSecret, body),
      },
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (err) {
    return { ok: false, error: err.code || 'REQUEST_FAILED' };
  }
}

async function processDue() {
  if (!enabled() || processing) return 0;
  processing = true;
  let handled = 0;
  try {
    const rows = await claimDue(10);
    for (const row of rows) {
      const result = await send(row);
      handled++;
      if (result.ok) {
        await update(row.id, {
          status: 'DELIVERED',
          attempts: row.attempts + 1,
          last_status_code: result.status,
          last_error: null,
          delivered_at: new Date().toISOString(),
        });
        logger.info('Callback terkirim', { order_id: row.payload.order_id });
        continue;
      }

      const attempts = row.attempts + 1;
      const failed = attempts >= config.callbackMaxAttempts;
      const delaySec = Math.min(10 * 2 ** (attempts - 1), 3600);
      await update(row.id, {
        status: failed ? 'FAILED' : 'PENDING',
        attempts,
        last_status_code: result.status || null,
        last_error: result.error || null,
        next_attempt_at: new Date(Date.now() + delaySec * 1000).toISOString(),
      });
      logger.warn('Callback gagal', { order_id: row.payload.order_id, attempts, status: result.status, code: result.error });
      if (failed) {
        telegram.notifyIntegrationError(
          'CALLBACK_FAILED',
          `Callback untuk order ${row.payload.order_id} gagal setelah ${attempts} percobaan. Pelanggan sudah membayar; kirim ulang lewat POST /callbacks/retry.`
        );
      }
    }
  } catch (err) {
    logger.error('Pemrosesan callback gagal', { error: err });
  } finally {
    processing = false;
  }
  return handled;
}

/**
 * Kirim callback yang sudah jatuh tempo sekarang juga. Mengembalikan Promise: di Vercel fungsi bisa
 * dibekukan begitu respons terkirim, jadi pemanggil sebaiknya `await` ini sebelum membalas.
 */
function kick() {
  if (!enabled()) return Promise.resolve(0);
  return processDue().catch(() => 0);
}

function start() {
  if (!enabled()) {
    logger.info('Callback dinonaktifkan (CALLBACK_URL/CALLBACK_SECRET belum diisi)');
    return;
  }
  timer = setInterval(() => processDue().catch(() => {}), 5000);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function list({ status, page, limit }) {
  return db.read((d) => {
    const byId = new Map(d.invoices.map((i) => [i.id, i]));
    const rows = d.callback_deliveries
      .filter((c) => !status || c.status === status)
      .sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
    const items = rows.slice((page - 1) * limit, page * limit).map((c) => ({
      id: c.id,
      order_id: (byId.get(c.invoice_id) || {}).order_id || null,
      event_type: c.event_type,
      status: c.status,
      attempts: c.attempts,
      next_attempt_at: c.next_attempt_at,
      last_status_code: c.last_status_code,
      last_error: c.last_error,
      delivered_at: c.delivered_at,
      created_at: c.created_at,
    }));
    return { items, total: rows.length };
  });
}

async function retry(orderId) {
  const n = await db.transaction((d) => {
    const inv = d.invoices.find((i) => i.order_id === orderId);
    if (!inv) return 0;
    let count = 0;
    for (const c of d.callback_deliveries) {
      if (c.invoice_id === inv.id && (c.status === 'FAILED' || c.status === 'PENDING')) {
        c.status = 'PENDING';
        c.attempts = 0;
        c.next_attempt_at = new Date().toISOString();
        c.updated_at = new Date().toISOString();
        count++;
      }
    }
    return count;
  });
  if (n > 0) await kick();
  return n;
}

module.exports = { enabled, processDue, kick, start, stop, list, retry };
