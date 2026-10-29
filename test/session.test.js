'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/utils/session');

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const INNER = 'B:EWznmVDIrF3y6Pt0XB3C3sQoKdsA3yxfPmGBHyUE';
const exp = Math.floor(Date.now() / 1000) + 3600;
const JWT = `${b64u({ alg: 'HS256' })}.${b64u({ userid: 123, exp, data: { tk: INNER } })}.sig`;

test('token B: langsung dikenali', () => {
  const r = s.parseCredential(INNER);
  assert.equal(r.token, INNER);
  assert.equal(r.cookieHeader, null);
});

test('JWT cookie: token dalam payload diekstrak, exp terbaca', () => {
  const r = s.parseCredential(JWT);
  assert.equal(r.token, INNER);
  assert.equal(r.cookieHeader, `${s.TOKEN_COOKIE_NAME}=${JWT}`);
  assert.ok(r.expiresAt instanceof Date);
});

test('header Cookie lengkap: token diekstrak dari cookie JWT, cookie lain ikut', () => {
  const r = s.parseCredential(`Cookie: SPC_EC=abc; ${s.TOKEN_COOKIE_NAME}=${encodeURIComponent(JWT)}; foo=bar`);
  assert.equal(r.token, INNER);
  assert.match(r.cookieHeader, /SPC_EC=abc/);
  assert.match(r.cookieHeader, /foo=bar/);
});

test('cookie tanpa JWT: cookie tersimpan, token null', () => {
  const r = s.parseCredential('a=1; b=2');
  assert.equal(r.token, null);
  assert.equal(r.cookieHeader, 'a=1; b=2');
});

test('input kosong / sampah tidak melempar', () => {
  assert.deepEqual(s.parseCredential('').token, null);
  assert.equal(s.parseCredential(undefined).cookieHeader, null);
  assert.equal(s.parseCredential('eyJ.bukan.jwt').token, null);
});

test('parseCurl: url, header, cookie, body JSON', () => {
  const curl = `curl 'https://shopeepay.shopee.co.id/partner-web/get-transaction-list' \\
  -H 'accept: application/json' \\
  -H 'origin: https://partner.shopee.co.id' \\
  -H 'user-agent: UA/1.0' \\
  -b '${s.TOKEN_COOKIE_NAME}=${JWT}; x=1' \\
  --data-raw '{"data":{"metadata":{"token":"${INNER}","language":"id"},"pageSize":10,"filter":{"serviceList":[1,3]}}}'`;
  const c = s.parseCurl(curl);
  assert.equal(c.url, 'https://shopeepay.shopee.co.id/partner-web/get-transaction-list');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers.origin, 'https://partner.shopee.co.id');
  assert.match(c.cookieHeader, /x=1/);
  assert.equal(s.tokenFromBody(c.bodyJson), INNER);
  assert.deepEqual(c.bodyJson.data.filter.serviceList, [1, 3]);
});

test('parseCurl: cookie lewat header -H Cookie dan $\'...\' (Chrome Windows/bash)', () => {
  const c = s.parseCurl(`curl $'https://x.example/api' -H $'Cookie: a=1; b=2' --data-raw $'{"data":{}}'`);
  assert.equal(c.cookieHeader, 'a=1; b=2');
  assert.deepEqual(c.bodyJson, { data: {} });
});

test('parseCurl menolak teks non-curl', () => {
  assert.throws(() => s.parseCurl('hello world'), /curl/i);
});
