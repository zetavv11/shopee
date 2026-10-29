'use strict';

/**
 * Penyimpanan berbasis berkas JSON (pengganti PostgreSQL).
 *
 * - Lokasi berkas: env DATABASE_FILE, atau ./database.json (lokal), atau /tmp/database.json di Vercel
 *   (satu-satunya folder yang bisa ditulis di Vercel).
 * - Semua perubahan lewat transaction(): diserialkan (antre), dikerjakan pada salinan data, lalu
 *   ditulis atomik (tulis ke berkas sementara -> rename). Bila fungsi melempar error, data tidak berubah.
 * - PENTING (Vercel): /tmp bersifat sementara dan terpisah per instance, jadi data bisa hilang saat
 *   cold start. Lihat README bagian "Batasan Vercel".
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

const COLLECTIONS = ['invoices', 'payment_events', 'webhook_events', 'callback_deliveries'];

function emptyData() {
  const d = {};
  for (const c of COLLECTIONS) d[c] = [];
  return d;
}

function resolveFile() {
  if (config.databaseFile) return path.resolve(config.databaseFile);
  if (config.isVercel) return '/tmp/database.json';
  return path.resolve(process.cwd(), 'database.json');
}

let cache = null;
let cacheMtime = 0;
let chain = Promise.resolve();

function normalize(parsed) {
  const d = emptyData();
  if (parsed && typeof parsed === 'object') {
    for (const c of COLLECTIONS) if (Array.isArray(parsed[c])) d[c] = parsed[c];
  }
  return d;
}

function load() {
  const file = resolveFile();
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (!stat) {
    // Berkas belum ada: mulai kosong dan buat berkas.
    cache = emptyData();
    persist(cache);
    return cache;
  }
  if (cache && stat.mtimeMs === cacheMtime) return cache;

  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) {
    cache = emptyData();
  } else {
    try {
      cache = normalize(JSON.parse(text));
    } catch (err) {
      // Jangan menimpa berkas yang rusak: berhenti dan minta manusia memeriksanya.
      throw new Error(`database.json rusak dan tidak bisa dibaca (${err.message}). Perbaiki atau hapus berkas ${file}.`);
    }
  }
  cacheMtime = stat.mtimeMs;
  return cache;
}

function persist(data) {
  const file = resolveFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
  cacheMtime = fs.statSync(file).mtimeMs;
}

/** Baca saja. `fn` menerima data hidup: JANGAN dimodifikasi; salin baris sebelum dikembalikan. */
async function read(fn) {
  await chain.catch(() => {});
  return fn(load());
}

/** Ubah data secara atomik. `fn(data)` memodifikasi salinan; hasil return-nya diteruskan. */
function transaction(fn) {
  const run = chain.catch(() => {}).then(async () => {
    const draft = structuredClone(load());
    const result = await fn(draft);
    persist(draft); // gagal menulis => error, cache lama tetap utuh
    cache = draft;
    return result;
  });
  chain = run;
  return run;
}

async function ping() {
  load();
}

async function close() {
  await chain.catch(() => {});
}

function filePath() {
  return resolveFile();
}

module.exports = { read, transaction, ping, close, filePath, COLLECTIONS };
