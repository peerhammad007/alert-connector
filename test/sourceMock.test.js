import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceMock } from '../src/mock/sourceMock.js';

async function token(base, m) {
  const r = await fetch(`${base}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: m.credentials.clientId, client_secret: m.credentials.clientSecret }),
  });
  return r;
}

test('serves paged alerts with metadata', async () => {
  const m = createSourceMock({ count: 120 });
  const base = await m.start();
  try {
    const { access_token } = await (await token(base, m)).json();
    const r = await fetch(`${base}/alerts?page=3&page_size=50`, { headers: { authorization: `Bearer ${access_token}` } });
    const body = await r.json();
    assert.equal(body.alerts.length, 20);
    assert.deepEqual(body.metadata, { count: 120, page: 3, total_pages: 3, page_size: 50 });
  } finally { await m.stop(); }
});

test('timestamp filter is inclusive', async () => {
  const m = createSourceMock({ count: 10 });
  const base = await m.start();
  try {
    const { access_token } = await (await token(base, m)).json();
    const ts = m.alerts[4].last_activity_timestamp;
    const r = await fetch(`${base}/alerts?last_activity_timestamp=${encodeURIComponent(ts)}`, { headers: { authorization: `Bearer ${access_token}` } });
    const body = await r.json();
    assert.equal(body.alerts[0].last_activity_timestamp, ts);
  } finally { await m.stop(); }
});

test('token endpoint returns 429 + Retry-After after the hourly limit', async () => {
  const m = createSourceMock({ tokenLimitPerHour: 2 });
  const base = await m.start();
  try {
    assert.equal((await token(base, m)).status, 200);
    assert.equal((await token(base, m)).status, 200);
    const r = await token(base, m);
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  } finally { await m.stop(); }
});

test('injected 503 then success', async () => {
  const m = createSourceMock();
  const base = await m.start();
  try {
    const { access_token } = await (await token(base, m)).json();
    m.inject({ alerts503: 1 });
    const h = { authorization: `Bearer ${access_token}` };
    assert.equal((await fetch(`${base}/alerts`, { headers: h })).status, 503);
    assert.equal((await fetch(`${base}/alerts`, { headers: h })).status, 200);
  } finally { await m.stop(); }
});
