'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbjson-'));
process.env.DATABASE_FILE = path.join(tmp, 'database.json');
process.env.API_KEY = 'test_api_key_1234567890';
process.env.CALLBACK_URL = 'https://example.com/cb';
process.env.CALLBACK_SECRET = 'callback_secret_1234567890';
process.env.INVOICE_GRACE_MINUTES = '10';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/database/db');
const invoices = require('../src/services/invoices');
const webhookEvents = require('../src/services/webhookEvents');

const inMinutes = (m) => new Date(Date.now() + m * 60000);
const base = (over = {}) => ({
  orderId: 'ORD-1',
  amount: 10000,
  uniqueCode: 0,
  payableAmount: 10000,
  provider: 'shopee-session',
  providerInvoiceId: null,
  qrisPayload: '000201...',
  qrisKind: 'static_injected',
  expiresAt: inMinutes(15),
  ...over,
});

test('insert membuat database.json dan menolak order_id / nominal PENDING ganda', async () => {
  const inv = await invoices.insert(base());
  assert.equal(inv.status, 'PENDING');
  assert.ok(fs.existsSync(process.env.DATABASE_FILE));

  await assert.rejects(invoices.insert(base()), (e) => e.code === '23505' && e.constraint === 'invoices_order_id_key');
  await assert.rejects(
    invoices.insert(base({ orderId: 'ORD-2' })),
    (e) => e.code === '23505' && e.constraint === 'invoices_pending_payable_amount_uidx'
  );
});

test('markPaid: nominal salah ditolak, benar -> PAID + callback antre, ulang -> ALREADY_PAID', async () => {
  const inv = await invoices.getByOrderId('ORD-1');

  const bad = await invoices.markPaid(inv.id, { id: 'TX1', amount: 9999, currency: 'IDR' }, 'poll');
  assert.equal(bad.result, 'MISMATCH');
  assert.equal((await invoices.getById(inv.id)).status, 'PENDING');

  const ok = await invoices.markPaid(inv.id, { id: 'TX1', amount: 10000, currency: 'IDR' }, 'poll');
  assert.equal(ok.result, 'PAID');
  assert.equal(ok.invoice.provider_txn_id, 'TX1');

  const again = await invoices.markPaid(inv.id, { id: 'TX1', amount: 10000, currency: 'IDR' }, 'poll');
  assert.equal(again.result, 'ALREADY_PAID');

  const counts = await db.read((d) => ({
    cb: d.callback_deliveries.length,
    ev: d.payment_events.filter((e) => e.event_type === 'PAID').length,
  }));
  assert.deepEqual(counts, { cb: 1, ev: 1 });
});

test('satu transaksi provider tidak bisa diklaim dua invoice', async () => {
  const other = await invoices.insert(base({ orderId: 'ORD-3' }));
  const r = await invoices.markPaid(other.id, { id: 'TX1', amount: 10000, currency: 'IDR' }, 'poll');
  assert.equal(r.result, 'TXN_ALREADY_CLAIMED');
  assert.equal((await invoices.getById(other.id)).status, 'PENDING');
});

test('expirePendingByPayable mengganti invoice PENDING bernominal sama', async () => {
  const n = await invoices.expirePendingByPayable(10000);
  assert.equal(n, 1);
  assert.equal((await invoices.getByOrderId('ORD-3')).status, 'EXPIRED');
});

test('expireStale menghormati masa tenggang', async () => {
  const fresh = await invoices.insert(base({ orderId: 'ORD-4', payableAmount: 20000, amount: 20000, expiresAt: inMinutes(-5) }));
  assert.equal(await invoices.expireStale(), 0); // lewat TTL tapi masih dalam tenggang 10 menit
  assert.equal((await invoices.getById(fresh.id)).status, 'PENDING');
  const old = await invoices.insert(base({ orderId: 'ORD-5', payableAmount: 30000, amount: 30000, expiresAt: inMinutes(-30) }));
  assert.equal(await invoices.expireStale(), 1);
  assert.equal((await invoices.getById(old.id)).status, 'EXPIRED');
});

test('listPending hanya memuat PENDING yang masih dalam tenggang', async () => {
  const p = await invoices.listPending();
  assert.deepEqual(p.map((x) => x.order_id), ['ORD-4']);
});

test('list: filter status, paginasi, total lunas', async () => {
  const all = await invoices.list({ page: 1, limit: 2 });
  assert.equal(all.items.length, 2);
  assert.equal(all.total, 4);
  assert.equal(all.totalPaidAmount, 10000);
  const paid = await invoices.list({ status: 'PAID', page: 1, limit: 10 });
  assert.equal(paid.total, 1);
});

test('data bertahan: dibaca ulang dari berkas setelah cache dibuang', async () => {
  const text = JSON.parse(fs.readFileSync(process.env.DATABASE_FILE, 'utf8'));
  assert.equal(text.invoices.length, 4);
  // simulasi edit manual berkas lalu baca lagi
  text.invoices[0].order_id = 'ORD-EDITED';
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(process.env.DATABASE_FILE, JSON.stringify(text));
  assert.ok(await invoices.getByOrderId('ORD-EDITED'));
});

test('transaction yang melempar error tidak mengubah data', async () => {
  const before = await db.read((d) => d.invoices.length);
  await assert.rejects(
    db.transaction((d) => {
      d.invoices.push({ id: 'x' });
      throw new Error('boom');
    })
  );
  assert.equal(await db.read((d) => d.invoices.length), before);
});

test('transaksi paralel diserialkan (tidak ada update hilang)', async () => {
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      invoices.insert(base({ orderId: `PAR-${i}`, payableAmount: 50000 + i, amount: 50000 + i }))
    )
  );
  assert.equal(await db.read((d) => d.invoices.filter((i) => i.order_id.startsWith('PAR-')).length), 20);
});

test('webhook event idempoten per event_id', async () => {
  const id = await webhookEvents.record({ eventId: 'e1', provider: 'p', signatureValid: false, simulated: true, payload: { a: 1 } });
  assert.ok(id);
  assert.equal(await webhookEvents.record({ eventId: 'e1', provider: 'p', signatureValid: false, simulated: true, payload: {} }), null);
  await webhookEvents.finish(id, 'PAID', null);
  assert.equal(await db.read((d) => d.webhook_events[0].result), 'PAID');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
