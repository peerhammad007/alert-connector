import test from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../src/client/http.js';

// A fake clock: time only moves when we say so, and sleep() just moves it forward.
function fakeTime(start = 0) {
  let t = start;
  const sleeps = [];
  return { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, advance: (ms) => { t += ms; }, sleeps };
}

test('the first N requests go through instantly (bucket starts full)', async () => {
  const c = fakeTime();
  const lim = createLimiter({ ratePerMin: 5, now: c.now, sleep: c.sleep });
  for (let i = 0; i < 5; i++) await lim.acquire();
  assert.deepEqual(c.sleeps, []);
});

test('the next request has to wait for one token to refill', async () => {
  const c = fakeTime();
  const lim = createLimiter({ ratePerMin: 60, now: c.now, sleep: c.sleep }); // 1 token per second
  for (let i = 0; i < 60; i++) await lim.acquire();
  await lim.acquire(); // bucket empty -> must wait ~1000 ms
  assert.equal(c.sleeps.length, 1);
  assert.ok(Math.abs(c.sleeps[0] - 1000) < 1, `waited ${c.sleeps[0]}`);
});

test('waiting in real (fake) time refills the bucket, capped at the rate', async () => {
  const c = fakeTime();
  const lim = createLimiter({ ratePerMin: 10, now: c.now, sleep: c.sleep });
  for (let i = 0; i < 10; i++) await lim.acquire();
  c.advance(10 * 60_000); // wait a long time; bucket must not exceed 10
  for (let i = 0; i < 10; i++) await lim.acquire();
  assert.deepEqual(c.sleeps, []);
  await lim.acquire(); // 11th in a row must wait
  assert.equal(c.sleeps.length, 1);
});
