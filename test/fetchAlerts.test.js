import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchAlertPages, runSync } from '../src/sync/fetchAlerts.js';
import { createAuth } from '../src/client/auth.js';
import { request } from '../src/client/http.js';
import { createSourceMock } from '../src/mock/sourceMock.js';

async function setup(mockOpts = {}) {
  const m = createSourceMock(mockOpts);
  const baseUrl = await m.start();
  const dir = await mkdtemp(path.join(tmpdir(), 'sync-'));
  const auth = createAuth({ baseUrl, clientId: m.credentials.clientId, clientSecret: m.credentials.clientSecret, statePath: path.join(dir, 'token.json') });
  const base = { baseUrl, getToken: auth.getToken, statePath: path.join(dir, 'sync.json'), deadLetterPath: path.join(dir, 'dead.jsonl'), pageSize: 50 };
  const alertPageCalls = (page) => m.state.requests.filter((r) => r.url.startsWith('/alerts') && new URL(r.url, 'http://x').searchParams.get('page') === String(page)).length;
  return { m, base, dir, alertPageCalls };
}
const noSleep = { sleep: async () => {} };
const fastHttp = (url, o, c) => request(url, o, c, noSleep);

test('fetchAlertPages: pages through everything', async () => {
  const { m, base } = await setup({ count: 120 });
  try {
    const seen = [];
    for await (const p of fetchAlertPages({ ...base, since: null, http: fastHttp })) seen.push(p);
    assert.deepEqual(seen.map((p) => p.page), [1, 2, 3]);
    assert.equal(seen.flatMap((p) => p.alerts).length, 120);
  } finally { await m.stop(); }
});

test('fetchAlertPages: since filter is passed (inclusive) and startPage is honoured', async () => {
  const { m, base } = await setup({ count: 120 });
  try {
    const since = m.alerts[100].last_activity_timestamp;
    const all = [];
    for await (const p of fetchAlertPages({ ...base, since, http: fastHttp })) all.push(...p.alerts);
    assert.ok(all.length >= 1 && all.length <= 20);
    assert.equal(all[0].last_activity_timestamp >= since, true);
    const pages = [];
    for await (const p of fetchAlertPages({ ...base, since: null, startPage: 3, http: fastHttp })) pages.push(p.page);
    assert.deepEqual(pages, [3]);
  } finally { await m.stop(); }
});

test('runSync: processes all, sets watermark to the max timestamp seen, second run only re-sees the boundary', async () => {
  const { m, base } = await setup({ count: 120 });
  try {
    const ids = [];
    const r1 = await runSync({ ...base, http: fastHttp, processAlert: (a) => { ids.push(a.id); } });
    assert.equal(r1.processed, 120);
    const max = m.alerts.map((a) => a.last_activity_timestamp).sort().at(-1);
    assert.equal(r1.watermark, max);
    const again = [];
    const r2 = await runSync({ ...base, http: fastHttp, processAlert: (a) => { again.push(a.id); } });
    assert.ok(r2.processed >= 1 && r2.processed <= 3, `re-fetched ${r2.processed}`); // only the inclusive boundary
    assert.equal(r2.watermark, max);
  } finally { await m.stop(); }
});

test('runSync: mid-run failure resumes from the checkpoint without refetching finished pages', async () => {
  const { m, base, alertPageCalls } = await setup({ count: 120 });
  try {
    let boom = true;
    const flaky = (url, o, c) => {
      if (boom && url.includes('page=2')) { boom = false; return Promise.reject(new Error('network down')); }
      return fastHttp(url, o, c);
    };
    await assert.rejects(() => runSync({ ...base, http: flaky, processAlert: () => {} }), /network down/);
    const state = JSON.parse(await readFile(base.statePath, 'utf8'));
    assert.equal(state.watermark ?? null, null);       // watermark did NOT move
    assert.equal(state.checkpoint.nextPage, 2);        // page 1 is done
    const r = await runSync({ ...base, http: flaky, processAlert: () => {} });
    assert.equal(r.processed, 70);                     // pages 2 and 3 only (50 + 20)
    assert.equal(alertPageCalls(1), 1);                // page 1 was fetched exactly once overall
    const done = JSON.parse(await readFile(base.statePath, 'utf8'));
    assert.equal(done.checkpoint, null);
    assert.ok(done.watermark);
  } finally { await m.stop(); }
});

test('runSync: a poison alert goes to the dead-letter file and does not block the run', async () => {
  const { m, base } = await setup({ count: 60 });
  try {
    const bad = m.alerts[10].id;
    const r = await runSync({ ...base, http: fastHttp, processAlert: (a) => { if (a.id === bad) throw new Error('cannot process'); } });
    assert.equal(r.deadLettered, 1);
    assert.equal(r.processed, 59);
    const lines = (await readFile(base.deadLetterPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].alert.id, bad);
    assert.match(lines[0].error, /cannot process/);
    assert.ok(r.watermark);
  } finally { await m.stop(); }
});
