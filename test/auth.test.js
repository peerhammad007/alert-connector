import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuth, TokenBackoffError } from '../src/client/auth.js';
import { createSourceMock } from '../src/mock/sourceMock.js';

async function setup(mockOpts = {}) {
  const m = createSourceMock(mockOpts);
  const baseUrl = await m.start();
  const dir = await mkdtemp(path.join(tmpdir(), 'auth-'));
  const make = (extra = {}) => createAuth({
    baseUrl, clientId: m.credentials.clientId, clientSecret: m.credentials.clientSecret,
    statePath: path.join(dir, 'token.json'), ...extra,
  });
  const tokenCalls = () => m.state.requests.filter((r) => r.url === '/oauth/token').length;
  return { m, make, dir, tokenCalls };
}

test('reuses a cached token (one token request for two getToken calls)', async () => {
  const { m, make, tokenCalls } = await setup();
  try {
    const auth = make();
    const a = await auth.getToken();
    const b = await auth.getToken();
    assert.equal(a, b);
    assert.equal(tokenCalls(), 1);
  } finally { await m.stop(); }
});

test('a new instance (simulating a new run) reuses the token from disk', async () => {
  const { m, make, tokenCalls } = await setup();
  try {
    const a = await make().getToken();
    const b = await make().getToken();
    assert.equal(a, b);
    assert.equal(tokenCalls(), 1);
  } finally { await m.stop(); }
});

test('refreshes when the token is within the safety margin of expiry', async () => {
  const { m, make, tokenCalls } = await setup();
  try {
    let t = Date.now();
    const auth = make({ now: () => t });
    await auth.getToken();
    t += 24 * 3600_000 - 60_000; // 1 minute before real expiry, inside the 5 minute margin
    await auth.getToken();
    assert.equal(tokenCalls(), 2);
  } finally { await m.stop(); }
});

test('429 is negative-cached: no more token requests until notBefore', async () => {
  const { m, make, dir, tokenCalls } = await setup({ tokenLimitPerHour: 1 });
  try {
    await make().getToken(); // uses up the hourly limit (1 token request)
    const fresh = make({ statePath: path.join(dir, 'other.json') }); // no cached token => must ask => 429
    await assert.rejects(() => fresh.getToken(), TokenBackoffError);
    assert.equal(tokenCalls(), 2);
    await assert.rejects(() => fresh.getToken(), TokenBackoffError); // must NOT hit the endpoint again
    await assert.rejects(() => make({ statePath: path.join(dir, 'other.json') }).getToken(), TokenBackoffError); // even from a new run
    assert.equal(tokenCalls(), 2);
  } finally { await m.stop(); }
});
