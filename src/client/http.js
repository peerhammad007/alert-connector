// Resilient HTTP helper. Build it in the order of the STEP comments.
// Run tests with: node --test test/http.unit.test.js

/**
 * @typedef {Object} RequestDeps  Things we pass in so tests can fake them.
 * @property {typeof fetch} [fetch]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [random]   returns 0..1
 */

// STEP 1a: decide whether a status code is worth retrying.
// Retry: 429 and any 5xx. Never retry: 400, 401, 403, 404 (retrying cannot fix them).
/** @param {number} status @returns {boolean} */
export function isRetryable(status) {
  return status === 429 || (status >= 500 && status < 600);
}

// STEP 1b: turn a Retry-After header into milliseconds.
// The header is either seconds ("3") or an HTTP date. Missing/garbage -> null.
// Hint: Number("3") works; for dates use Date.parse(value) - now.
/** @param {string | null} value @param {number} [now] epoch ms @returns {number | null} */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value.trim() === '') return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds * 1000 : null;
  }

  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - now);
}

// STEP 1c: how long to wait before retry number `attempt` (0, 1, 2...).
// delay = min(capMs, baseMs * 2^attempt), then multiply by random() ("full jitter").
// Why jitter: so many clients that failed together don't all retry together.
/** @param {number} attempt @param {{baseMs?: number, capMs?: number, random?: () => number}} [opts] @returns {number} */
export function backoffDelay(attempt, { baseMs = 500, capMs = 30000, random = Math.random } = {}) {
  const delay = Math.min(capMs, baseMs * 2 ** attempt);
  return delay * random();
}

// STEP 2: one attempt with a timeout. Returns the Response, or throws on timeout/network error.
// Hint: fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
/** @param {string} url @param {RequestInit} options @param {number} timeoutMs @param {RequestDeps} [deps] @returns {Promise<Response>} */
export async function attempt(url, options, timeoutMs, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  return fetchImpl(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// STEP 3: the retry loop. Call attempt() up to maxRetries+1 times.
//  - success (ok or non-retryable status): return the response
//  - retryable status: wait max(backoffDelay(n), Retry-After) then try again
//  - thrown error (timeout/network): treat as retryable
//  - out of retries: return the last response, or throw the last error
// Pass deps.sleep so tests do not really wait.
/** @param {string} url @param {RequestInit} [options] @param {{timeoutMs?: number, maxRetries?: number}} [config] @param {RequestDeps} [deps] @returns {Promise<Response>} */
export async function request(url, options = {}, { timeoutMs = 10000, maxRetries = 3 } = {}, deps = {}) {
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;

  for (let retry = 0; ; retry++) {
    let response;
    try {
      response = await attempt(url, options, timeoutMs, deps);
    } catch (error) {
      if (retry >= maxRetries) throw error;
      await sleep(backoffDelay(retry, { random }));
      continue;
    }

    if (!isRetryable(response.status) || retry >= maxRetries) return response;

    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    const delay = backoffDelay(retry, { random });
    await sleep(Math.max(delay, retryAfter ?? 0));
  }
}

// STEP 4 (last): token bucket limiter, e.g. 100 requests per minute.
// Keep `tokens` (starts full). Refill over time: tokens += elapsedMs * ratePerMin / 60000, capped at ratePerMin.
// acquire(): if tokens >= 1, take one and return; else sleep until one is available, then take it.
/** @param {{ratePerMin?: number, now?: () => number, sleep?: (ms: number) => Promise<void>}} [opts] @returns {{acquire: () => Promise<void>}} */
export function createLimiter({ ratePerMin = 100, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!Number.isFinite(ratePerMin) || ratePerMin <= 0) {
    throw new RangeError('ratePerMin must be a positive finite number');
  }

  let tokens = ratePerMin;
  let lastRefill = now();

  return {
    async acquire() {
      while (true) {
        const currentTime = now();
        const elapsedMs = Math.max(0, currentTime - lastRefill);
        tokens = Math.min(ratePerMin, tokens + elapsedMs * ratePerMin / 60000);
        lastRefill = Math.max(lastRefill, currentTime);

        if (tokens >= 1) {
          tokens -= 1;
          return;
        }

        const waitMs = (1 - tokens) * 60000 / ratePerMin;
        await sleep(waitMs);
      }
    },
  };
}
