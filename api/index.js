'use strict';

// Entry point Vercel: seluruh aplikasi Express berjalan sebagai satu serverless function.
// (Worker setInterval tidak dipakai di sini; lihat /cron/tick dan README.)
const config = require('../src/config');
const { createApp } = require('../src/app');

let app;
try {
  config.validate();
  app = createApp();
} catch (err) {
  // Konfigurasi salah: tampilkan pesan jelas (tanpa nilai rahasia) alih-alih crash tanpa keterangan.
  app = (req, res) => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: { code: 'CONFIG_ERROR', message: err.message } }));
  };
}

module.exports = app;
