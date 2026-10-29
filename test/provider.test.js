'use strict';

process.env.API_KEY = process.env.API_KEY || 'test_api_key_1234567890';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _internals: p } = require('../src/services/paymentProvider');

test('parseAmount: format rupiah portal "409.662" = 409662 (bukan sen)', () => {
  assert.equal(p.parseAmount('409.662'), 409662);
  assert.equal(p.parseAmount('1.234.567'), 1234567);
  assert.equal(p.parseAmount('Rp 15.000'), 15000);
  assert.equal(p.parseAmount('10.000,00'), 10000);
  assert.equal(p.parseAmount('15000'), 15000);
  assert.equal(p.parseAmount(15000), 15000);
  assert.equal(p.parseAmount('15000.00'), 15000);
});

test('parseAmount: nominal negatif / pecahan / sampah ditolak', () => {
  assert.equal(p.parseAmount(-5000), null);
  assert.equal(p.parseAmount('-5.000'), null);
  assert.equal(p.parseAmount(1.5), null);
  assert.equal(p.parseAmount('abc'), null);
  assert.equal(p.parseAmount(null), null);
});

test('status sukses = angka 3 (juga teks "success")', () => {
  assert.equal(p.isSuccessStatus(3), true);
  assert.equal(p.isSuccessStatus('3'), true);
  assert.equal(p.isSuccessStatus('success'), true);
  assert.equal(p.isSuccessStatus(1), false);
  assert.equal(p.isSuccessStatus(2), false);
  assert.equal(p.isSuccessStatus(undefined), false);
});

test('normalizeTransaction: bentuk numerik status + amount string + epoch detik', () => {
  const t = p.normalizeTransaction({
    transactionId: '264693445089687719',
    displayTransactionId: 'SP123',
    amount: '1.008',
    status: 3,
    createTime: 1784050941,
  });
  assert.equal(t.id, '264693445089687719');
  assert.equal(t.amount, 1008);
  assert.equal(t.success, true);
  assert.equal(t.time.getTime(), 1784050941 * 1000);
});

test('normalizeTransaction: baris tanpa id atau nominal valid dibuang', () => {
  assert.equal(p.normalizeTransaction({ amount: '1.000' }), null);
  assert.equal(p.normalizeTransaction({ transactionId: 'x', amount: 'n/a' }), null);
  assert.equal(p.normalizeTransaction(null), null);
});

test('extractList: kunci dikenal, kunci tak dikenal, dan tidak ada', () => {
  assert.deepEqual(p.extractList({ data: { transactions: [{ a: 1 }] } }), [{ a: 1 }]);
  assert.deepEqual(p.extractList({ data: { foo: [{ a: 1 }], next_position: 'x' } }), [{ a: 1 }]);
  assert.deepEqual(p.extractList({ data: { list: [] } }), []);
  assert.equal(p.extractList({ data: { total: 3 } }), null);
  assert.equal(p.extractList('<html>'), null);
});

test('nextCursorOf: next_position / nextPosition, kosong = null', () => {
  assert.equal(p.nextCursorOf({ data: { next_position: 'abc' } }), 'abc');
  assert.equal(p.nextCursorOf({ data: { nextPosition: 'def' } }), 'def');
  assert.equal(p.nextCursorOf({ data: { next_position: '' } }), null);
  assert.equal(p.nextCursorOf({ data: {} }), null);
});

test('buildListPayload: token di data.metadata.token, epoch detik, cursor diteruskan', () => {
  const start = new Date('2026-10-29T10:00:00Z');
  const end = new Date('2026-10-29T11:00:00Z');
  const body = p.buildListPayload('B:tok', { limit: 10, startDate: start, endDate: end, cursor: 'CUR' });
  assert.equal(body.data.metadata.token, 'B:tok');
  assert.equal(body.data.pageSize, 10);
  assert.equal(body.data.filter.startTime, Math.floor(start.getTime() / 1000));
  assert.equal(body.data.filter.endTime, Math.floor(end.getTime() / 1000));
  assert.deepEqual(body.data.filter.serviceList, [1, 3]);
  assert.equal(body.data.next_position, 'CUR');
});
