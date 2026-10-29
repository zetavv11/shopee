'use strict';

const crypto = require('crypto');
const db = require('../database/db');
const config = require('../config');

const nowIso = () => new Date().toISOString();
const ts = (v) => new Date(v).getTime();
const graceMs = () => config.invoiceGraceMinutes * 60 * 1000;

function conflict(constraint) {
  const err = new Error(`duplicate key value violates unique constraint "${constraint}"`);
  err.code = '23505'; // kode yang sama dengan PostgreSQL agar route tidak perlu berubah
  err.constraint = constraint;
  return err;
}

function isStale(inv, now) {
  return inv.status === 'PENDING' && ts(inv.expires_at) + graceMs() < now;
}

// Masa tenggang: mutasi portal bisa tertunda beberapa menit, jadi invoice baru ditutup
// (EXPIRED) setelah expires_at + INVOICE_GRACE_MINUTES. Waktu transaksi tetap harus <= expires_at.
async function expireStale() {
  const now = Date.now();
  const hasStale = await db.read((d) => d.invoices.some((i) => isStale(i, now)));
  if (!hasStale) return 0;
  return db.transaction((d) => {
    let n = 0;
    for (const inv of d.invoices) {
      if (isStale(inv, now)) {
        inv.status = 'EXPIRED';
        inv.updated_at = nowIso();
        n++;
      }
    }
    return n;
  });
}

// Menutup (EXPIRED) invoice PENDING yang nominal bayarnya sama, supaya QRIS baru bisa dibuat.
async function expirePendingByPayable(payableAmount) {
  const hasAny = await db.read((d) => d.invoices.some((i) => i.status === 'PENDING' && Number(i.payable_amount) === payableAmount));
  if (!hasAny) return 0;
  return db.transaction((d) => {
    let n = 0;
    for (const inv of d.invoices) {
      if (inv.status === 'PENDING' && Number(inv.payable_amount) === payableAmount) {
        inv.status = 'EXPIRED';
        inv.updated_at = nowIso();
        d.payment_events.push({
          id: crypto.randomUUID(),
          invoice_id: inv.id,
          event_type: 'REPLACED',
          from_status: 'PENDING',
          to_status: 'EXPIRED',
          amount: payableAmount,
          currency: null,
          provider_txn_id: null,
          source: 'create-qris',
          event_key: null,
          details: { reason: 'digantikan QRIS baru dengan nominal sama' },
          created_at: nowIso(),
        });
        n++;
      }
    }
    return n;
  });
}

async function insert(row) {
  return db.transaction((d) => {
    if (d.invoices.some((i) => i.order_id === row.orderId)) throw conflict('invoices_order_id_key');
    if (d.invoices.some((i) => i.status === 'PENDING' && Number(i.payable_amount) === row.payableAmount)) {
      throw conflict('invoices_pending_payable_amount_uidx');
    }
    const now = nowIso();
    const inv = {
      id: crypto.randomUUID(),
      order_id: row.orderId,
      amount: row.amount,
      unique_code: row.uniqueCode,
      payable_amount: row.payableAmount,
      currency: 'IDR',
      status: 'PENDING',
      provider: row.provider,
      provider_invoice_id: row.providerInvoiceId || null,
      provider_txn_id: null,
      qris_payload: row.qrisPayload || null,
      qris_kind: row.qrisKind || null,
      expires_at: new Date(row.expiresAt).toISOString(),
      paid_at: null,
      created_at: now,
      updated_at: now,
    };
    d.invoices.push(inv);
    return { ...inv };
  });
}

async function getByOrderId(orderId) {
  return db.read((d) => {
    const inv = d.invoices.find((i) => i.order_id === orderId);
    return inv ? { ...inv } : null;
  });
}

async function getById(id) {
  return db.read((d) => {
    const inv = d.invoices.find((i) => i.id === id);
    return inv ? { ...inv } : null;
  });
}

/**
 * Menandai invoice lunas secara atomik. Hanya dipanggil setelah pembayaran terverifikasi
 * (cocok dari mutasi provider atau webhook terverifikasi / simulasi development).
 *
 * Hasil: PAID | ALREADY_PAID | NOT_PENDING | MISMATCH | TXN_ALREADY_CLAIMED | NOT_FOUND
 */
async function markPaid(invoiceId, tx, source, details = {}) {
  return db.transaction((d) => {
    const inv = d.invoices.find((i) => i.id === invoiceId);
    if (!inv) return { result: 'NOT_FOUND' };
    if (inv.status === 'PAID') return { result: 'ALREADY_PAID', invoice: { ...inv } };
    if (inv.status !== 'PENDING') return { result: 'NOT_PENDING', invoice: { ...inv } };
    if (Number(inv.payable_amount) !== Number(tx.amount) || tx.currency !== inv.currency) {
      return { result: 'MISMATCH', invoice: { ...inv } };
    }
    // Satu transaksi provider hanya boleh diklaim satu invoice.
    if (d.invoices.some((i) => i.id !== inv.id && i.provider_txn_id && i.provider_txn_id === tx.id)) {
      return { result: 'TXN_ALREADY_CLAIMED', invoice: { ...inv } };
    }

    const now = nowIso();
    inv.status = 'PAID';
    inv.provider_txn_id = tx.id;
    inv.paid_at = now;
    inv.updated_at = now;

    const eventKey = `PAID:${invoiceId}`;
    if (!d.payment_events.some((e) => e.event_key === eventKey)) {
      d.payment_events.push({
        id: crypto.randomUUID(),
        invoice_id: invoiceId,
        event_type: 'PAID',
        from_status: 'PENDING',
        to_status: 'PAID',
        amount: tx.amount,
        currency: tx.currency,
        provider_txn_id: tx.id,
        source,
        event_key: eventKey,
        details,
        created_at: now,
      });
    }

    // Masukkan callback ke antrean di transaksi yang sama: lunas dan callback selalu konsisten.
    if (config.callbackUrl && !d.callback_deliveries.some((c) => c.invoice_id === invoiceId && c.event_type === 'payment.paid')) {
      d.callback_deliveries.push({
        id: crypto.randomUUID(),
        invoice_id: invoiceId,
        event_type: 'payment.paid',
        payload: {
          event: 'payment.paid',
          event_id: `evt_${invoiceId}`,
          order_id: inv.order_id,
          invoice_id: inv.id,
          amount: Number(inv.amount),
          payable_amount: Number(inv.payable_amount),
          currency: inv.currency,
          status: 'PAID',
          transaction_id: tx.id,
          paid_at: inv.paid_at,
          source,
        },
        status: 'PENDING',
        attempts: 0,
        next_attempt_at: now,
        last_status_code: null,
        last_error: null,
        delivered_at: null,
        created_at: now,
        updated_at: now,
      });
    }
    return { result: 'PAID', invoice: { ...inv } };
  });
}

async function listPending(limit = 200) {
  const now = Date.now();
  return db.read((d) =>
    d.invoices
      .filter((i) => i.status === 'PENDING' && ts(i.expires_at) + graceMs() >= now)
      .sort((a, b) => ts(a.created_at) - ts(b.created_at))
      .slice(0, limit)
      .map((i) => ({
        id: i.id,
        order_id: i.order_id,
        payable_amount: i.payable_amount,
        created_at: i.created_at,
        expires_at: i.expires_at,
      }))
  );
}

async function list({ status, orderId, from, to, page, limit }) {
  return db.read((d) => {
    const rows = d.invoices
      .filter((i) => {
        if (status && i.status !== status) return false;
        if (orderId && i.order_id !== orderId) return false;
        if (from && ts(i.created_at) < from.getTime()) return false;
        if (to && ts(i.created_at) >= to.getTime()) return false;
        return true;
      })
      .sort((a, b) => ts(b.created_at) - ts(a.created_at) || (a.id < b.id ? -1 : 1));

    const paidTotal = rows.filter((i) => i.status === 'PAID').reduce((sum, i) => sum + Number(i.payable_amount), 0);
    return {
      items: rows.slice((page - 1) * limit, page * limit).map((i) => ({ ...i })),
      total: rows.length,
      totalPaidAmount: paidTotal,
    };
  });
}

function serialize(row, { includePayload = false, qrisUrl = null } = {}) {
  const out = {
    invoice_id: row.id,
    order_id: row.order_id,
    amount: Number(row.amount),
    unique_code: row.unique_code,
    payable_amount: Number(row.payable_amount),
    currency: row.currency,
    status: row.status,
    qris_kind: row.qris_kind,
    expires_at: row.expires_at,
    paid_at: row.paid_at,
    created_at: row.created_at,
  };
  if (row.provider_txn_id) out.provider_txn_id = row.provider_txn_id;
  if (qrisUrl) out.qris_url = qrisUrl;
  if (includePayload) out.qris_payload = row.qris_payload;
  return out;
}

module.exports = { expireStale, expirePendingByPayable, insert, getByOrderId, getById, markPaid, listPending, list, serialize };
