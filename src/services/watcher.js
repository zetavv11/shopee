'use strict';

/**
 * Pemantau pembayaran otomatis.
 * - Hanya memanggil provider bila ada invoice PENDING (saat sepi: nol request ke provider).
 * - Satu panggilan daftar mutasi dicocokkan ke SEMUA invoice pending sekaligus.
 * - Saat token ditolak provider, pemantauan dijeda 5 menit agar token tidak ditembak terus.
 * Aman dijalankan di beberapa instance: penandaan lunas dikunci di database (markPaid).
 */

const config = require('../config');
const logger = require('../utils/logger');
const provider = require('./paymentProvider');
const invoices = require('./invoices');
const telegram = require('./telegram');
const callbacks = require('./callbacks');
const { matchPending } = require('../utils/matching');

const PAUSE_ON_INVALID_MS = 5 * 60 * 1000;
const PAUSE_ON_BLOCKED_MS = 2 * 60 * 1000; // 403 / 429: jangan menembak terus

let timer = null;
let running = false;
let started = false;
let pausedUntil = 0;
let lastErrorCode = null;

async function tick() {
  const summary = { skipped: null, pending: 0, paid: 0, error: null };
  if (running) return { ...summary, skipped: 'RUNNING' };
  if (Date.now() < pausedUntil) return { ...summary, skipped: 'PAUSED' };
  running = true;
  try {
    if (!provider.capabilities().canCheckPayment) {
      lastErrorCode = 'NOT_CONFIGURED';
      return { ...summary, skipped: 'NOT_CONFIGURED' };
    }

    await invoices.expireStale();
    const pending = await invoices.listPending(200);
    if (pending.length === 0) {
      lastErrorCode = null;
      return summary;
    }
    summary.pending = pending.length;

    const earliest = Math.min(...pending.map((p) => new Date(p.created_at).getTime()));
    const startDate = new Date(earliest - 60 * 1000);
    // Paginasi cursor dilakukan di dalam provider (pageSize kecil, mengikuti next_position).
    const txs = await provider.getTransactions({ limit: 200, startDate, endDate: new Date() });
    lastErrorCode = null;

    for (const { invoice, tx } of matchPending(pending, txs)) {
      const r = await invoices.markPaid(
        invoice.id,
        { id: tx.id, amount: tx.amount, currency: tx.currency },
        'watcher',
        { issuer: tx.issuer, provider_time: tx.time }
      );
      if (r.result === 'PAID') {
        logger.info('Pembayaran terverifikasi', { order_id: invoice.order_id });
        summary.paid++;
        await telegram.notifyPaymentVerified(r.invoice, { id: tx.id, issuer: tx.issuer });
        await callbacks.kick();
      }
    }
    return summary;
  } catch (err) {
    summary.error = err.code || 'WATCHER_ERROR';
    lastErrorCode = err.code || 'WATCHER_ERROR';
    logger.warn('Pemantauan pembayaran gagal', { code: lastErrorCode, message: err.message });
    if (err.code === 'PROVIDER_TOKEN_INVALID') {
      pausedUntil = Date.now() + PAUSE_ON_INVALID_MS;
      await telegram.notifyIntegrationError(err.code, 'Sesi ditolak. Perbarui lewat POST /update-session (cookie/cURL) atau env SHOPEE_COOKIE / SHOPEE_TOKEN.');
    } else if (err.code === 'PROVIDER_FORBIDDEN' || err.code === 'PROVIDER_RATE_LIMITED') {
      pausedUntil = Date.now() + PAUSE_ON_BLOCKED_MS;
      await telegram.notifyIntegrationError(err.code, err.message);
    }
    return summary;
  } finally {
    running = false;
  }
}

function start() {
  if (config.watchIntervalSeconds <= 0) {
    logger.info('Pemantauan pembayaran otomatis dinonaktifkan (WATCH_INTERVAL_SECONDS=0)');
    return;
  }
  started = true;
  timer = setInterval(tick, config.watchIntervalSeconds * 1000);
  setTimeout(tick, 2000);
}

function stop() {
  started = false;
  if (timer) clearInterval(timer);
  timer = null;
}

/** true bila watcher sehat; /check-payment lalu cukup membaca database tanpa menembak provider. */
function isActive() {
  return started && Date.now() >= pausedUntil && lastErrorCode === null;
}

module.exports = { start, stop, tick, isActive };
