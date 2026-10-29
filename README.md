# ShopeePay API Gateway (Node.js + database.json + Vercel)

Gateway API untuk membuat invoice QRIS dan memeriksa status pembayaran, dengan penyimpanan transaksi di berkas `database.json` (tanpa database server) dan siap dijalankan di Vercel.
Struktur endpoint dan nama environment mengikuti repo referensi `ahmadzakiyox/shoppepay-api-gateway`, tetapi kode ditulis ulang dari nol
(repo referensi berlisensi proprietary, kodenya tidak disalin).

## Baca dulu: apa yang BENAR-BENAR dilakukan proyek ini

Hasil analisis repo referensi (hanya README yang dapat diperiksa; `server.js` tidak dapat dibuka):

| Hal | Repo referensi | Proyek ini |
|---|---|---|
| Penyimpanan | Stateless (RAM) | `database.json` (invoice, event pembayaran, event webhook, antrean callback) |
| `SHOPEE_TOKEN` | Token **sesi** Partner Portal (`B:...`) diambil manual dari DevTools. **Bukan** kredensial merchant resmi | Sama. Token ini bisa mati kapan saja dan penggunaannya bisa melanggar ketentuan Shopee |
| Cek mutasi | Memanggil endpoint internal portal yang tidak terdokumentasi | Sama, lewat adapter. Nama field request/respons adalah **asumsi awal** (lihat "Blok capture") |
| `/create-qris` | Menyuntik nominal ke QRIS statis + hitung ulang CRC16 | Sama (`qris_kind: "static_injected"`). Ini **bukan** invoice dinamis resmi dari provider |
| Webhook | README menyebut, tidak ada rincian | `501 NOT_CONFIGURED` di produksi karena signature resmi tidak terdokumentasi |
| API key | Header atau `?api_key=` | Hanya header `X-API-Key` (query string bocor ke log/URL) |

Status token (`GET /token-status`):

- `NOT_CONFIGURED`: kredensial sesi (`SHOPEE_COOKIE`/`SHOPEE_TOKEN`) atau alamat endpoint (`SHOPEE_TRANSACTIONS_URL`/`SHOPEE_API_BASE`) kosong.
- `UNVERIFIED`: provider tidak dapat dihubungi atau format respons tidak dikenali.
- `VALID`: provider menjawab uji langsung dengan token itu dan format dikenali. Ini bukti uji langsung, **bukan** validasi resmi (tidak ada mekanisme resmi).
- `INVALID`: provider menolak token (HTTP 401/403 atau kode `200020`).

Pembayaran hanya ditandai lunas bila ditemukan transaksi sukses di mutasi provider dengan nominal sama persis, waktu di antara pembuatan invoice dan kedaluwarsa,
dan `transaction_id` yang belum diklaim invoice lain (dijamin pemeriksaan atomik di penyimpanan). Klaim dari client tidak pernah dianggap bukti.

### Memakai cookie Partner Portal (cara yang direkomendasikan)

Portal `https://partner.shopee.co.id/shopeepay-portal/transactions` memanggil endpoint `get-transaction-list` dengan sesi login-mu.
Gateway meniru request itu memakai sesi **akun merchant milikmu sendiri** (read-only). Fakta berikut berasal dari riset proyek komunitas, bukan dokumentasi resmi:

- Cookie login bernama `__shopee_partner_website_x_token_live` berisi **JWT**; di dalam payload-nya ada token `B:...` yang sama dengan `data.metadata.token` pada body request. Gateway mengekstraknya otomatis.
- Mutasi diminta dengan filter waktu epoch **detik**, `serviceList: [1, 3]`, paginasi cursor `next_position`, dan `pageSize` kecil (praktik: **maks 10**).
- Nominal berupa string bertitik ribuan: `"409.662"` = Rp409.662 (bukan sen). Status **sukses = angka `3`**.
- Daftar mutasi bisa **tertunda beberapa menit** (indexing), karena itu ada `INVOICE_GRACE_MINUTES`.

**Langkah (±2 menit):**

1. Login ke `https://partner.shopee.co.id`, buka halaman **ShopeePay > Transaksi**.
2. Tekan `F12` > tab **Network** > filter **Fetch/XHR** > refresh halaman.
3. Klik request **`get-transaction-list`** > klik kanan > **Copy** > **Copy as cURL (bash)**.
4. Kirim ke gateway (satu kali, atau setiap sesi mati):

```bash
# simpan hasil "Copy as cURL (bash)" ke file curl.txt, lalu:
curl -X POST https://nama-project.vercel.app/update-session \
  -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
  -d "$(jq -Rs '{curl: .}' curl.txt)"
```

Gateway mengambil **URL, cookie, token, header, dan kerangka payload** dari cURL itu. Alternatif manual:
`{"cookie": "<header Cookie lengkap atau nilai cookie JWT>", "url": "<Request URL>"}`.

5. Uji: `curl -s $BASE/token-status -H "X-API-Key: $KEY"` harus menampilkan `VALID`.

Agar permanen, isi env `SHOPEE_COOKIE` dan `SHOPEE_TRANSACTIONS_URL` di Vercel (Project > Settings > Environment Variables, lalu Redeploy). `/update-session` dan `/update-token` hanya mengubah memori satu instance; **di Vercel perubahan itu cepat hilang** (cold start / instance lain), jadi anggap env sebagai sumber yang sah.
Cookie/token **kedaluwarsa** (lihat `session.jwt_expires_at` di `/token-status`); saat itu terjadi watcher berhenti, mengirim alert Telegram, dan kamu perlu mengulang langkah 3-4.

### Jika `/token-status` tidak `VALID`

| Gejala | Penyebab umum | Tindakan |
|---|---|---|
| `NOT_CONFIGURED` | URL endpoint belum diisi, atau cookie/token kosong | Isi `SHOPEE_TRANSACTIONS_URL` + `SHOPEE_COOKIE`, atau pakai `/update-session` |
| `INVALID` / `PROVIDER_TOKEN_INVALID` | Sesi kedaluwarsa, redirect ke login, kode `200020` | Ambil cURL baru (langkah 3-4) |
| `PROVIDER_FORBIDDEN` (403) | Cookie pendamping tidak ikut, atau **IP server (Vercel/hosting) diblokir anti-bot** | Pakai cURL lengkap (bukan token saja); isi `SHOPEE_USER_AGENT` sama dengan browser-mu; bila tetap 403, jalankan gateway dari jaringan lain (mis. VPS/rumah) |
| `PROVIDER_NON_JSON` | URL salah / halaman login / anti-bot | Pastikan URL = Request URL `get-transaction-list` |
| `UNVERIFIED` + `PROVIDER_UNRECOGNIZED_RESPONSE` | Struktur respons berbeda dari dugaan | Lihat `diagnostics` (nama field respons, tanpa nilai) dan sesuaikan `normalizeTransaction` |

`GET /token-status` menyertakan `session` (ada/tidaknya token & cookie, nama cookie, kedaluwarsa JWT) dan `diagnostics` (status HTTP, nama field respons, jumlah baris) untuk debugging tanpa membocorkan rahasia.

### Blok capture

Di `src/services/paymentProvider.js` blok `BLOK TERGANTUNG-CAPTURE` memuat nama field yang bersifat dugaan beralasan (beberapa kandidat per field). Bila `diagnostics.row_keys` menunjukkan nama berbeda, tambahkan ke daftar kandidat di `normalizeTransaction`.

## Instalasi di Termux

```bash
pkg update && pkg upgrade
pkg install nodejs git
cd ~                      # gunakan home Termux, JANGAN /sdcard (masalah permission & symlink)
git clone REPOSITORY_URL
cd shopeepay-api-gateway
npm install               # menghasilkan package-lock.json (commit file ini)
cp .env.example .env
nano .env
```

Isi `.env`:

- `API_KEY`: string acak minimal 16 karakter. Buat dengan `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- `DATABASE_FILE`: opsional. Kosong = `./database.json` (dibuat otomatis saat pertama jalan).
- `QRIS_STATIC`: string QRIS statis merchant milikmu (opsional; tanpa ini `/create-qris` mengembalikan `NOT_CONFIGURED`).
- `SHOPEE_COOKIE` + `SHOPEE_TRANSACTIONS_URL` (atau `SHOPEE_TOKEN` + `SHOPEE_API_BASE`): opsional, diperlukan untuk verifikasi pembayaran (lihat "Memakai cookie Partner Portal").
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`: opsional.

Jalankan server (tidak perlu migrasi; `database.json` dibuat otomatis):

```bash
npm start            # atau: npm run dev (auto-reload)
```

Tes unit (tanpa jaringan): `npm test`.

## Deploy ke Vercel

1. **GitHub**: buat repository **Private**, lalu `git init && git add . && git commit -m "init"`, `git remote add origin URL_REPO`, `git push -u origin main`.
   `.env` dan `database.json` sudah di `.gitignore` (jangan di-commit: berisi secret dan data transaksi).
2. **Import ke Vercel**: vercel.com > Add New > Project > pilih repo. Framework preset: **Other**. Build/Output biarkan kosong.
   `vercel.json` dan `api/index.js` sudah menyiapkan seluruh aplikasi sebagai satu serverless function.
3. **Environment Variables** (Settings > Environment Variables): `API_KEY` (wajib), `QRIS_STATIC`, `SHOPEE_COOKIE`, `SHOPEE_TRANSACTIONS_URL`,
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `PUBLIC_BASE_URL` (mis. `https://nama-project.vercel.app`), dan bila memakai callback: `CALLBACK_URL`, `CALLBACK_SECRET`.
   Setelah mengubah env, lakukan **Redeploy**.
4. **Uji**: `curl https://nama-project.vercel.app/api/health`. Bila konfigurasi salah, respons berisi `CONFIG_ERROR` beserta daftar yang kurang (tanpa nilai rahasia).
5. **Pemantauan pembayaran**: Vercel tidak menjalankan proses latar belakang, jadi `WATCH_INTERVAL_SECONDS` tidak berlaku di sana. Gantinya:
   - `POST /check-payment` otomatis menembak mutasi provider saat dipanggil (website/bot kamu polling tiap beberapa detik), dan
   - `GET /cron/tick` (header `X-API-Key`) mengecek **semua** invoice PENDING + mengirim callback yang jatuh tempo. Panggil tiap 1 menit dari cron eksternal
     (mis. cron-job.org atau GitHub Actions). Vercel Cron paket Hobby hanya boleh 1x/hari, jadi tidak cukup; bila memakai Vercel Cron (paket berbayar), isi `CRON_SECRET`.
6. **Log**: Project > Logs (format JSON, secret otomatis disamarkan).

### Batasan Vercel + database.json (baca ini)

Vercel adalah serverless: sistem berkas **hanya-baca** kecuali `/tmp`, dan `/tmp` bersifat **sementara serta terpisah untuk tiap instance**. Akibatnya di Vercel,
`database.json` berada di `/tmp/database.json` dan:

- **Data hilang** saat instance di-recycle / cold start / deploy ulang (biasanya dalam hitungan menit sampai jam bila sepi).
- **Bisa tidak konsisten antar instance**: `/create-qris` dan `/check-payment` bisa dilayani instance berbeda yang masing-masing punya `database.json` sendiri,
  sehingga invoice terlihat `INVOICE_NOT_FOUND` atau pembayaran tidak terdeteksi.
- Rate limit dan throttle juga per instance.

Artinya konfigurasi ini cocok untuk **uji coba/demo**, belum aman untuk pembayaran sungguhan. Untuk produksi, ganti penyimpanan dengan yang persisten
(mis. Upstash Redis / Vercel KV, Vercel Blob, atau Postgres seperti Neon/Supabase), atau jalankan gateway di server yang selalu hidup (VPS/Render/Railway) dengan `database.json` di disk persisten.
Semua akses data terpusat di `src/database/db.js` (+ `invoices.js`, `callbacks.js`, `webhookEvents.js`), jadi penggantian dilakukan di sana tanpa mengubah route.

## Alur lengkap: pelanggan bayar → otomatis lunas → produk terkirim

```
Website/Bot (server)         Gateway                         Shopee
   │ POST /create-qris ───────▶ simpan invoice PENDING
   │◀─ qris_url, payable_amount ┘
   │  tampilkan QR ke pelanggan
   │                          Pelanggan scan & bayar ───────────▶
   │                          watcher (tiap 10 dtk, hanya bila ada PENDING)
   │                            ├─ ambil mutasi ◀──────────────────
   │                            ├─ cocokkan nominal + waktu + ID transaksi unik
   │                            └─ tandai LUNAS (transaksi SQL) + antre callback
   │◀─ POST CALLBACK_URL  (X-Gateway-Signature) ┘
   │  verifikasi tanda tangan → cek order & nominal → KIRIM PRODUK
```

Aturan emas: **produk hanya boleh dikirim dari backend**, setelah (a) callback bertanda tangan valid, atau (b) `POST /check-payment` dari server kamu
mengembalikan `paid: true`. Jangan pernah mengirim produk karena browser/bot pelanggan "bilang sudah bayar", dan jangan menaruh `API_KEY` di JavaScript browser.

1. Backend website memanggil `POST /create-qris` dengan **harga dari database kamu** (bukan dari input pelanggan), `order_id` unik.
2. Tampilkan `qris_url` (gambar PNG) dan **`payable_amount`** (bila `UNIQUE_CODE_MAX` aktif, nominal bayar sedikit berbeda dari harga). Pelanggan harus membayar nominal persis itu.
3. Gateway memantau mutasi sendiri (`WATCH_INTERVAL_SECONDS`, default 10 detik), menandai lunas, lalu mengirim callback ke `CALLBACK_URL`.
4. Backend website menerima callback, memverifikasi, lalu mengirim produk. Contoh lengkap: `examples/website-callback-receiver.js`.
5. Halaman checkout cukup polling endpoint **backend-mu sendiri** (yang membaca status pesanan) untuk menampilkan "Pembayaran diterima".
   Backend-mu boleh juga memanggil `/check-payment` sebagai cadangan; saat watcher sehat, endpoint ini hanya membaca database dan tidak menembak Shopee.

Variabel env tambahan: `WATCH_INTERVAL_SECONDS`, `CALLBACK_URL` (https), `CALLBACK_SECRET` (min 16 karakter, sama di gateway dan website), `CALLBACK_MAX_ATTEMPTS`.

### Format callback

`POST CALLBACK_URL` dengan `Content-Type: application/json` dan header `X-Gateway-Event`, `X-Gateway-Event-Id`, `X-Gateway-Signature: t=<unix>,v1=<hex>`:

```json
{
  "event": "payment.paid",
  "event_id": "evt_<invoice_id>",
  "order_id": "ORDER-123",
  "invoice_id": "uuid",
  "amount": 15000,
  "payable_amount": 15000,
  "currency": "IDR",
  "status": "PAID",
  "transaction_id": "264693445089687719",
  "paid_at": "2026-10-29T10:03:11.000Z",
  "source": "watcher"
}
```

Verifikasi: `v1 = HMAC_SHA256(CALLBACK_SECRET, "<t>." + <body mentah>)`, tolak bila `t` selisih lebih dari 5 menit. Balas **2xx** bila berhasil.
Selain 2xx (atau timeout) gateway mencoba lagi dengan jeda 10 dtk, 20 dtk, 40 dtk, … (maks. 1 jam) hingga `CALLBACK_MAX_ATTEMPTS`, lalu status `FAILED` dan alert Telegram.
Pengiriman bersifat *at-least-once*: callback yang sama bisa datang lebih dari sekali, jadi proses secara idempotent (pakai `event_id`/`order_id`; contoh sudah menanganinya).
Pantau callback macet: `GET /callbacks?status=FAILED`; kirim ulang: `POST /callbacks/retry` dengan `{ "order_id": "..." }`.

### Batasan yang perlu kamu ketahui

- Otomatisasi ini bergantung pada token sesi Partner Portal yang tidak resmi. Bila token mati, pembayaran **tidak** terdeteksi: watcher berhenti 5 menit, mengirim alert Telegram,
  dan `/token-status` menampilkan `INVALID`. Perbarui lewat `POST /update-session` atau env `SHOPEE_COOKIE`. Pelanggan yang sudah bayar saat itu perlu ditangani manual atau
  otomatis terdeteksi setelah token diperbarui selama invoice belum kedaluwarsa.
- Pembayaran yang masuk **setelah** invoice kedaluwarsa tidak ditandai lunas otomatis (uang masuk, produk tidak terkirim). Atur `INVOICE_TTL_MINUTES` secukupnya dan sediakan jalur bantuan manual.
- Pencocokan memakai nominal + jendela waktu. Tanpa `UNIQUE_CODE_MAX`, dua pelanggan dengan nominal sama pada waktu bersamaan akan ditolak (`AMOUNT_IN_USE`); aktifkan kode unik untuk toko ramai.
- Di Vercel tidak ada watcher otomatis dan `database.json` bersifat sementara (lihat "Batasan Vercel"). Untuk pembayaran sungguhan gunakan penyimpanan persisten dan panggil `/cron/tick` tiap menit.

## Referensi API

Semua endpoint selain `/api/health` dan `/qr/:id` memerlukan header `X-API-Key`.
Error selalu berbentuk `{ "success": false, "error": { "code": "...", "message": "..." } }`.

| Method & path | Keterangan |
|---|---|
| `GET /api/health` | Publik. `{ success, status: "online", timestamp }` |
| `GET /token-status` | Status integrasi: `NOT_CONFIGURED/UNVERIFIED/VALID/INVALID` (opsional header `X-Shopee-Token` untuk uji token lain) |
| `POST /update-token` | Body `{ "token": "B:... atau JWT cookie" }`; ganti token di memori proses (tidak disimpan, hilang saat restart) |
| `POST /update-session` | Body `{ curl }` atau `{ cookie, url, token }`; ganti sesi portal (URL, cookie, token, kerangka payload) di memori proses. Batas body 100 KB |
| `POST /create-qris` | Body `{ amount, order_id }`. Validasi integer positif, batas `MIN_AMOUNT`/`MAX_AMOUNT`, format `order_id`, tolak duplikat (409). Respons 201 berisi `invoice_id`, `order_id`, `amount`, `unique_code`, `payable_amount`, `status`, `qris_kind`, `qris_payload`, `qris_url`, `expires_at` |
| `GET /qr/:id` | Publik. Gambar PNG QR (hanya invoice PENDING, ID berupa UUID acak) |
| `POST /check-payment` | Body `{ order_id }`. Mengembalikan `{ success, paid, status, transaction?, data }`. Dibatasi interval minimal `MIN_CHECK_INTERVAL_SECONDS` per invoice |
| `GET /transactions` | Transaksi **lokal** dari database.json. Query: `page`, `limit` (maks 100), `status`, `order_id` |
| `GET /transactions/all` | Transaksi lokal dengan `start_date`, `end_date` (YYYY-MM-DD, WIB), `status`, paginasi (maks 500), dan `total_paid_amount` |
| `GET /transactions/provider` | Mutasi langsung dari provider (butuh sesi). Query: `limit` (maks 100), `start_date`, `end_date`; paginasi cursor ditangani otomatis |
| `GET /callbacks` | Antrean callback keluar (`status=PENDING/DELIVERED/FAILED`, paginasi) |
| `POST /callbacks/retry` | Body `{ order_id }`; jadwalkan ulang callback PENDING/FAILED |
| `POST /webhooks/payment` | Produksi: `501 NOT_CONFIGURED` (signature resmi tidak terdokumentasi). Development: simulasi, lihat di bawah |

Catatan penting: `/transactions` dan `/transactions/all` hanya menampilkan transaksi yang dibuat lewat gateway ini.
Endpoint ini **tidak** otomatis memberikan seluruh mutasi merchant ShopeePay.

`UNIQUE_CODE_MAX` (default 0): bila diisi, mis. 99, gateway menambahkan kode unik Rp1..99 ke nominal sehingga `payable_amount` berbeda untuk setiap invoice PENDING.
Bila 0, dua invoice PENDING dengan nominal sama ditolak (`409 AMOUNT_IN_USE`) karena pembayarannya tidak dapat dibedakan.

## Pengujian dengan curl

```bash
BASE=http://localhost:3001
KEY=ISI_API_KEY_KAMU

# Health
curl -s $BASE/api/health

# Status token
curl -s $BASE/token-status -H "X-API-Key: $KEY"

# Buat invoice
curl -s -X POST $BASE/create-qris -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
  -d '{"amount":15000,"order_id":"ORDER-123"}'

# Cek pembayaran
curl -s -X POST $BASE/check-payment -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
  -d '{"order_id":"ORDER-123"}'

# Daftar transaksi lokal
curl -s "$BASE/transactions?status=PENDING&page=1&limit=20" -H "X-API-Key: $KEY"
curl -s "$BASE/transactions/all?start_date=2026-10-01&end_date=2026-10-31" -H "X-API-Key: $KEY"

# Tanpa API key (harus 401)
curl -s -i -X POST $BASE/create-qris -H "Content-Type: application/json" -d '{"amount":15000,"order_id":"ORDER-124"}'

# Input invalid (harus 400)
curl -s -X POST $BASE/create-qris -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
  -d '{"amount":"15000","order_id":"!!"}'

# Webhook simulasi (HANYA NODE_ENV=development; nominal harus sama dengan payable_amount)
curl -s -X POST $BASE/webhooks/payment -H "Content-Type: application/json" \
  -H "X-API-Key: $KEY" -H "X-Dev-Simulation: true" \
  -d '{"event_id":"sim-1","order_id":"ORDER-123","amount":15000,"currency":"IDR"}'
```

Di `NODE_ENV=production`, simulasi webhook ditolak (`501`) dan tidak pernah menandai invoice lunas. Event simulasi di development ditandai `simulated=true`.

## Integrasi bot Telegram

Notifikasi (invoice dibuat, pembayaran terverifikasi, error integrasi) dikirim bila `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_ID` terisi.
Kegagalan notifikasi tidak pernah mengubah status pembayaran.

Contoh bot penjualan ada di `examples/telegram-bot.js`: `/produk` menampilkan katalog, `/beli KODE` membuat QRIS (harga dari katalog di server bot),
lalu bot memantau `/check-payment` dan mengirim produk begitu `paid: true`. Ganti `PRODUCTS` dengan katalog dan stok milikmu.
Isi `.env` bot dengan token **milikmu sendiri**; jangan memakai token dari repo atau percakapan mana pun.
Bot bisa memakai polling `/check-payment` (seperti contoh) atau callback ke server bot, sama seperti website.

## Keamanan

- `API_KEY` dibandingkan dengan `timingSafeEqual`; server menolak start bila `API_KEY` kosong, pendek, atau masih nilai contoh.
- Helmet, rate limit global, batas body 10 KB, timeout HTTP, error handler terpusat, query selalu berparameter.
- Log tidak memuat secret (redaksi otomatis key sensitif, nilai env rahasia, connection string, token bot). Token/API key tidak disimpan di `database.json`.
- Pembayaran ganda dicegah: semua perubahan lewat transaksi yang diserialkan + ditulis atomik (tulis berkas sementara lalu rename), `provider_txn_id` hanya bisa diklaim satu invoice, nominal PENDING harus unik, dan `event_key` unik di `payment_events`. (Jaminan ini hanya berlaku dalam satu proses/instance.)
- Invoice kedaluwarsa tidak akan dicocokkan lagi; pembayaran yang masuk setelah kedaluwarsa tidak otomatis ditandai lunas dan perlu ditangani manual.
- Graceful shutdown (SIGTERM/SIGINT) menutup server dengan rapi.
- Penggunaan token sesi dan endpoint internal Partner Portal bersifat tidak resmi dan menjadi tanggung jawabmu. Pahami syarat & ketentuan ShopeePay sebelum memakainya untuk produksi komersial.

## Struktur

```
src/app.js                    entry point, middleware, graceful shutdown
src/config.js                 pembacaan & validasi environment
src/routes/                   health, token, qris, transactions, webhooks, callbacks, cron
src/services/                 paymentProvider (adapter), telegram, invoices (akses data + markPaid),
                              watcher (pemantau otomatis), callbacks (callback keluar + retry)
src/middleware/apiKey.js      autentikasi X-API-Key
src/database/db.js              penyimpanan database.json (transaksi atomik)
api/index.js                  entry point Vercel (serverless)
vercel.json                   rewrite semua path ke api/index.js
src/utils/                    logger, errors, validate, qris (penyuntik TLV + CRC16)
src/utils/session.js          parser cookie/JWT/cURL DevTools (ekstrak token B: dari JWT)
examples/telegram-bot.js      contoh bot: /produk, /beli KODE -> bayar -> produk terkirim
examples/website-callback-receiver.js  contoh penerima callback di backend website
test/                         tes unit (qris, logger, matching, signature, session, store)
```
