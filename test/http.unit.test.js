import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetryable, parseRetryAfter, backoffDelay, request } from '../src/client/http.js';
import { createSourceMock } from '../src/mock/sourceMock.js';

// ---- STEP 1: pure functions ----
test('isRetryable: 429 and 5xx yes, client errors no', () => {
  for (const s of [429, 500, 502, 503, 504]) assert.equal(isRetryable(s), true, String(s));
  for (const s of [200, 400, 401, 403, 404]) assert.equal(isRetryable(s), false, String(s));
});

test('parseRetryAfter: seconds, date, and garbage', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('abc'), null);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now), 5000);
});

test('backoffDelay: grows exponentially, capped, jittered', () => {
  const noJitter = () => 1; // random()=1 means "full" delay
  assert.equal(backoffDelay(0, { baseMs: 500, capMs: 30000, random: noJitter }), 500);
  assert.equal(backoffDelay(1, { baseMs: 500, capMs: 30000, random: noJitter }), 1000);
  assert.equal(backoffDelay(2, { baseMs: 500, capMs: 30000, random: noJitter }), 2000);
  assert.equal(backoffDelay(20, { baseMs: 500, capMs: 30000, random: noJitter }), 30000);
  assert.equal(backoffDelay(2, { baseMs: 500, capMs: 30000, random: () => 0.5 }), 1000);
});

// ---- STEP 3: retry loop against the mock ----
async function setup() {
  const m = createSourceMock();
  const base = await m.start();
  const { access_token } = await (await fetch(`${base}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: m.credentials.clientId, client_secret: m.credentials.clientSecret }),
  })).json();
  return { m, base, headers: { authorization: `Bearer ${access_token}` } };
}

test('request: retries 503 then succeeds', async () => {
  const { m, base, headers } = await setup();
  try {
    m.inject({ alerts503: 2 });
    const sleeps = [];
    const res = await request(`${base}/alerts`, { headers }, { maxRetries: 3 }, { sleep: async (ms) => { sleeps.push(ms); } });
    assert.equal(res.status, 200);
    assert.equal(sleeps.length, 2); // slept twice, but instantly
  } finally { await m.stop(); }
});

test('request: waits at least Retry-After on 429', async () => {
  const { m, base, headers } = await setup();
  try {
    m.inject({ alerts429: 1, retryAfterSec: 4 });
    const sleeps = [];
    await request(`${base}/alerts`, { headers }, {}, { sleep: async (ms) => { sleeps.push(ms); }, random: () => 0 });
    assert.ok(sleeps[0] >= 4000, `slept ${sleeps[0]}`);
  } finally { await m.stop(); }
});

test('request: never retries 401', async () => {
  const { m, base } = await setup();
  try {
    const before = m.state.requests.length;
    const res = await request(`${base}/alerts`, {}, {}, { sleep: async () => {} });
    assert.equal(res.status, 401);
    assert.equal(m.state.requests.length - before, 1);
  } finally { await m.stop(); }
});
