'use strict';

const crypto = require('crypto');
const db = require('../database/db');

/** Catat event webhook. Mengembalikan id baris, atau null bila event_id sudah pernah diproses (idempotensi). */
async function record({ eventId, provider, signatureValid, simulated, payload }) {
  return db.transaction((d) => {
    if (d.webhook_events.some((e) => e.event_id === eventId)) return null;
    const id = crypto.randomUUID();
    d.webhook_events.push({
      id,
      event_id: eventId,
      provider,
      signature_valid: Boolean(signatureValid),
      simulated: Boolean(simulated),
      payload,
      invoice_id: null,
      result: null,
      received_at: new Date().toISOString(),
      processed_at: null,
    });
    return id;
  });
}

async function finish(id, result, invoiceId = null) {
  return db.transaction((d) => {
    const row = d.webhook_events.find((e) => e.id === id);
    if (row) {
      row.result = result;
      row.invoice_id = invoiceId;
      row.processed_at = new Date().toISOString();
    }
  });
}

module.exports = { record, finish };
