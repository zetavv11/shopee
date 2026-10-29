'use strict';

require('dotenv').config();

const env = process.env;

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const nodeEnv = env.NODE_ENV || 'development';

const config = {
  nodeEnv,
  isProd: nodeEnv === 'production',
  isDev: nodeEnv === 'development',

  port: int(env.PORT, 3001),
  host: '0.0.0.0',

  apiKey: env.API_KEY || '',
  shopeeToken: (env.SHOPEE_TOKEN || '').trim(),
  // Cookie sesi Partner Portal: header Cookie lengkap, "name=value", atau nilai JWT cookie
  // __shopee_partner_website_x_token_live. Token "B:..." diekstrak otomatis bila ada.
  shopeeCookie: (env.SHOPEE_COOKIE || '').trim(),
  shopeeApiBase: (env.SHOPEE_API_BASE || '').trim(),
  shopeeListPath: (env.SHOPEE_LIST_PATH || '/get-transaction-list').trim(),
  // URL lengkap request get-transaction-list hasil capture DevTools (mengalahkan BASE + PATH).
  shopeeListUrl: (env.SHOPEE_TRANSACTIONS_URL || '').trim(),
  shopeeOrigin: (env.SHOPEE_ORIGIN || 'https://partner.shopee.co.id').trim().replace(/\/+$/, ''),
  shopeeUserAgent: (env.SHOPEE_USER_AGENT || '').trim(),
  // Portal membatasi pageSize (praktik komunitas: maks 10). Naikkan hanya bila hasil capture-mu mengizinkan.
  providerPageSize: Math.max(1, Math.min(int(env.PROVIDER_PAGE_SIZE, 10), 100)),
  providerMaxPages: Math.max(1, Math.min(int(env.PROVIDER_MAX_PAGES, 10), 50)),
  qrisStatic: (env.QRIS_STATIC || '').trim(),

  telegramBotToken: (env.TELEGRAM_BOT_TOKEN || '').trim(),
  telegramChatId: (env.TELEGRAM_CHAT_ID || '').trim(),

  // Penyimpanan berkas JSON (pengganti PostgreSQL). Kosong = ./database.json (lokal) atau /tmp/database.json (Vercel).
  databaseFile: (env.DATABASE_FILE || '').trim(),
  isVercel: Boolean(env.VERCEL),
  // Rahasia untuk endpoint /cron/tick (Vercel Cron mengirim "Authorization: Bearer <CRON_SECRET>").
  cronSecret: (env.CRON_SECRET || '').trim(),

  publicBaseUrl: (env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
  invoiceTtlMinutes: int(env.INVOICE_TTL_MINUTES, 15),
  // get-transaction-list di portal bisa tertunda beberapa menit; invoice tetap dicocokkan
  // selama masa tenggang ini (waktu transaksi tetap harus di dalam TTL invoice).
  invoiceGraceMinutes: Math.max(0, Math.min(int(env.INVOICE_GRACE_MINUTES, 10), 120)),
  minAmount: int(env.MIN_AMOUNT, 1000),
  maxAmount: int(env.MAX_AMOUNT, 10000000),
  uniqueCodeMax: Math.max(0, Math.min(int(env.UNIQUE_CODE_MAX, 0), 999)),

  rateLimitPerMin: int(env.RATE_LIMIT_PER_MIN, 120),
  minCheckIntervalMs: Math.max(0, int(env.MIN_CHECK_INTERVAL_SECONDS, 5)) * 1000,
  providerTimeoutMs: int(env.PROVIDER_TIMEOUT_MS, 10000),

  // Pemantauan otomatis & callback ke website/bot
  watchIntervalSeconds: Math.max(0, int(env.WATCH_INTERVAL_SECONDS, 10)),
  callbackUrl: (env.CALLBACK_URL || '').trim(),
  callbackSecret: (env.CALLBACK_SECRET || '').trim(),
  callbackMaxAttempts: Math.max(1, int(env.CALLBACK_MAX_ATTEMPTS, 10)),

  // Bila true: invoice PENDING dengan nominal sama otomatis di-EXPIRED saat membuat QRIS baru (untuk testing).
  replacePendingSameAmount: bool(env.REPLACE_PENDING_SAME_AMOUNT, true),
  logLevel: (env.LOG_LEVEL || 'info').toLowerCase(),
};

/**
 * Validasi konfigurasi wajib. Pesan error TIDAK pernah memuat nilai variabel.
 */
config.validate = function validate() {
  const problems = [];

  if (!config.apiKey || config.apiKey.length < 16 || config.apiKey === 'replace_with_a_long_random_secret') {
    problems.push('API_KEY wajib diisi dengan string acak minimal 16 karakter (bukan nilai contoh).');
  }
  if (config.cronSecret && config.cronSecret.length < 16) {
    problems.push('CRON_SECRET minimal 16 karakter bila dipakai.');
  }
  if (config.minAmount < 1 || config.maxAmount < config.minAmount) {
    problems.push('MIN_AMOUNT/MAX_AMOUNT tidak valid.');
  }
  if (config.invoiceTtlMinutes < 1 || config.invoiceTtlMinutes > 1440) {
    problems.push('INVOICE_TTL_MINUTES harus antara 1 dan 1440.');
  }
  if (config.shopeeApiBase && !/^https:\/\//i.test(config.shopeeApiBase)) {
    problems.push('SHOPEE_API_BASE harus diawali https://');
  }
  if (config.shopeeListUrl && !/^https:\/\//i.test(config.shopeeListUrl)) {
    problems.push('SHOPEE_TRANSACTIONS_URL harus diawali https://');
  }
  if (!config.shopeeListPath.startsWith('/')) {
    problems.push('SHOPEE_LIST_PATH harus diawali "/".');
  }

  if (config.watchIntervalSeconds > 0 && config.watchIntervalSeconds < 5) {
    problems.push('WATCH_INTERVAL_SECONDS minimal 5 (atau 0 untuk menonaktifkan).');
  }
  if (config.callbackUrl) {
    let u = null;
    try {
      u = new URL(config.callbackUrl);
    } catch (_) {
      problems.push('CALLBACK_URL bukan URL yang valid.');
    }
    if (u) {
      const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && !config.isProd)) {
        problems.push('CALLBACK_URL harus https:// (http hanya untuk localhost saat development).');
      }
    }
    if (config.callbackSecret.length < 16) {
      problems.push('CALLBACK_SECRET wajib diisi minimal 16 karakter bila CALLBACK_URL dipakai.');
    }
  }

  if (problems.length) {
    const err = new Error('Konfigurasi tidak valid:\n- ' + problems.join('\n- '));
    err.isConfigError = true;
    throw err;
  }
};

module.exports = config;
