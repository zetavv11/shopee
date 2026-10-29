'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const watcher = require('../services/watcher');
const callbacks = require('../services/callbacks');
const invoices = require('../services/invoices');
const { AppError, asyncHandler } = require('../utils/errors');

const router = express.Router();

const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
const same = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

// Boleh dipanggil dengan X-API-Key (cron eksternal) ATAU "Authorization: Bearer <CRON_SECRET>" (Vercel Cron).
function cronAuth(req, res, next) {
  const key = req.get('x-api-key');
  if (key && same(key, config.apiKey)) return next();
  const auth = req.get('authorization') || '';
  if (config.cronSecret && auth.startsWith('Bearer ') && same(auth.slice(7), config.cronSecret)) return next();
  return next(new AppError(401, 'UNAUTHORIZED', 'Kredensial cron tidak ada atau tidak valid.'));
}

/**
 * Pengganti worker latar belakang (setInterval) yang tidak bisa berjalan di Vercel serverless.
 * Satu panggilan: tutup invoice kedaluwarsa, cek mutasi provider untuk semua invoice PENDING,
 * lalu kirim callback yang jatuh tempo. Panggil tiap 1 menit dari cron eksternal (lihat README).
 */
async function tick(req, res) {
  await invoices.expireStale();
  const watch = await watcher.tick();
  const delivered = await callbacks.processDue();
  res.json({ success: true, data: { watcher: watch, callbacks_processed: delivered } });
}

router.get('/tick', cronAuth, asyncHandler(tick));
router.post('/tick', cronAuth, asyncHandler(tick));

module.exports = router;
