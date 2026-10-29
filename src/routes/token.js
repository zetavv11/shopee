'use strict';

const express = require('express');
const apiKey = require('../middleware/apiKey');
const config = require('../config');
const provider = require('../services/paymentProvider');
const watcher = require('../services/watcher');
const callbacks = require('../services/callbacks');
const { AppError, asyncHandler } = require('../utils/errors');

const router = express.Router();

function readTokenOverride(req) {
  const t = req.get('x-shopee-token');
  if (!t) return undefined;
  if (t.length < 10 || t.length > 4000 || /\s/.test(t)) {
    throw new AppError(400, 'INVALID_TOKEN', 'Format X-Shopee-Token tidak valid.');
  }
  return t;
}

// NOT_CONFIGURED | UNVERIFIED | VALID | INVALID  (berdasarkan bukti uji langsung ke provider)
router.get(
  '/token-status',
  apiKey,
  asyncHandler(async (req, res) => {
    const result = await provider.validateCredentials({ token: readTokenOverride(req) });
    res.json({
      success: true,
      data: {
        token_status: result.state,
        message: result.message,
        checked_at: result.checkedAt,
        capabilities: provider.capabilities(),
        session: provider.sessionInfo(),
        // Ringkasan respons terakhir dari portal: hanya NAMA field & status, tanpa nilai/rahasia.
        diagnostics: provider.diagnostics(),
        watcher: { enabled: config.watchIntervalSeconds > 0, active: watcher.isActive() },
        callback_configured: callbacks.enabled(),
      },
    });
  })
);

// Mengganti token / JWT cookie di memori proses (tidak disimpan ke disk/DB, hilang saat restart).
router.post(
  '/update-token',
  apiKey,
  asyncHandler(async (req, res) => {
    const token = req.body && req.body.token;
    if (typeof token !== 'string' || token.length < 10 || token.length > 4000 || /\s/.test(token)) {
      throw new AppError(400, 'INVALID_TOKEN', 'token harus berupa string tanpa spasi (10-4000 karakter).');
    }
    const info = provider.setToken(token);
    res.json({
      success: true,
      message: 'Token diperbarui di memori. Panggil GET /token-status untuk menguji.',
      data: info,
    });
  })
);

function optString(value, name, max) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new AppError(400, 'INVALID_SESSION', `${name} harus berupa string (maks ${max} karakter).`);
  }
  return value;
}

// Mengganti sesi Partner Portal di memori proses. Body (isi salah satu atau kombinasi):
//   { "curl": "<Copy as cURL (bash) dari request get-transaction-list>" }   <- paling mudah & lengkap
//   { "cookie": "<header Cookie lengkap | name=value | nilai JWT cookie>", "url": "https://..." }
//   { "token": "B:..." }
router.post(
  '/update-session',
  apiKey,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    let applied;
    try {
      applied = provider.setSession({
        curl: optString(body.curl, 'curl', 60000),
        cookie: optString(body.cookie, 'cookie', 16000),
        token: optString(body.token, 'token', 4000),
        url: optString(body.url, 'url', 2000),
      });
    } catch (err) {
      if (err instanceof provider.ProviderError) throw err;
      throw new AppError(400, 'INVALID_SESSION', err.message);
    }
    res.json({
      success: true,
      message: 'Sesi diperbarui di memori. Panggil GET /token-status untuk menguji.',
      data: applied,
    });
  })
);

module.exports = router;
