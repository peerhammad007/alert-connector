// Fake "Doppel-shaped" alert API. Synthetic data only. Shapes are approximate, not the real contract.
import http from 'node:http';

/** Small seeded PRNG so the same seed always gives the same alerts. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const QUEUE_STATES = ['doppel_review', 'needs_confirmation', 'actioned', 'taken_down', 'monitoring', 'archived'];
const ENTITY_STATES = ['active', 'down', 'parked', 'suspicious', 'unclassified', 'unrelated', 'related', 'unknown'];
const PRODUCTS = ['domains', 'social_media', 'telco'];

/**
 * @param {{seed?: number, count?: number, start?: string}} opts
 */
export function generateAlerts({ seed = 1, count = 300, start = '2026-01-01T00:00:00Z' } = {}) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const t0 = Date.parse(start);
  const alerts = [];
  for (let i = 0; i < count; i++) {
    const product = pick(PRODUCTS);
    const n = 1000 + i;
    const entity =
      product === 'domains' ? `Acme-Login-${n}.example.test`
      : product === 'social_media' ? `https://social.example.test/acme_support_${n}`
      : `+1555010${String(n).slice(-4)}`;
    alerts.push({
      id: `TST-${n}`,
      entity,
      product,
      queue_state: pick(QUEUE_STATES),
      entity_state: pick(ENTITY_STATES),
      score: rnd() < 0.2 ? null : Math.round(rnd() * 100) / 100,
      created_at: new Date(t0 + i * 60_000).toISOString(),
      // 1 alert per minute, ascending. Ties are deliberate below to exercise the inclusive filter.
      last_activity_timestamp: new Date(t0 + Math.floor(i / 2) * 60_000 + i * 1000).toISOString(),
    });
  }
  return alerts;
}

/**
 * @param {{seed?: number, count?: number, tokenLimitPerHour?: number, clientId?: string, clientSecret?: string}} [opts]
 */
export function createSourceMock(opts = {}) {
  const { tokenLimitPerHour = 5, clientId = 'test-client', clientSecret = 'test-secret' } = opts;
  const alerts = generateAlerts(opts);

  const state = {
    tokensIssued: /** @type {number[]} */ ([]), // epoch ms of each issue
    validTokens: new Set(),
    requests: /** @type {{method:string,url:string}[]} */ ([]), // every request, for asserting "no refetch"
    failures: { alerts429: 0, alerts503: 0, tokenSlowMs: 0, alertsSlowMs: 0, retryAfterSec: 1, dropFirstAlertAfterPage1: false },
  };

  /** Provoke failures for the next N calls. */
  function inject(partial) { Object.assign(state.failures, partial); }

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) => new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    state.requests.push({ method: req.method ?? '', url: req.url ?? '' });
    const f = state.failures;

    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      if (f.tokenSlowMs) await new Promise((r) => setTimeout(r, f.tokenSlowMs));
      const body = await readBody(req);
      if (body.client_id !== clientId || body.client_secret !== clientSecret) {
        return json(res, 401, { error: 'invalid_client' });
      }
      const now = Date.now();
      state.tokensIssued = state.tokensIssued.filter((t) => now - t < 3600_000);
      if (state.tokensIssued.length >= tokenLimitPerHour) {
        const wait = Math.ceil((3600_000 - (now - state.tokensIssued[0])) / 1000);
        return json(res, 429, { error: 'token_rate_limited' }, { 'retry-after': String(wait) });
      }
      state.tokensIssued.push(now);
      const token = `tok_${now}_${state.tokensIssued.length}`;
      state.validTokens.add(token);
      return json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 86400 });
    }

    if (req.method === 'GET' && url.pathname === '/alerts') {
      const auth = req.headers.authorization ?? '';
      if (!state.validTokens.has(auth.replace(/^Bearer /, ''))) return json(res, 401, { error: 'unauthorized' });
      if (f.alertsSlowMs) await new Promise((r) => setTimeout(r, f.alertsSlowMs));
      if (f.alerts429 > 0) { f.alerts429--; return json(res, 429, { error: 'rate_limited' }, { 'retry-after': String(f.retryAfterSec) }); }
      if (f.alerts503 > 0) { f.alerts503--; return json(res, 503, { error: 'unavailable' }); }

      const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
      const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('page_size') ?? 50)));
      if (!Number.isInteger(page) || !Number.isInteger(pageSize)) return json(res, 400, { error: 'bad_request' });
      const since = url.searchParams.get('last_activity_timestamp');

      let rows = alerts;
      if (since) rows = rows.filter((a) => a.last_activity_timestamp >= since); // inclusive: "at or after"
      // "data changes between page 1 and page 2": drop the first row once page 1 has been served.
      if (f.dropFirstAlertAfterPage1 && page > 1) rows = rows.slice(1);

      const total = rows.length;
      const slice = rows.slice((page - 1) * pageSize, page * pageSize);
      return json(res, 200, {
        alerts: slice,
        metadata: { count: total, page, total_pages: Math.max(1, Math.ceil(total / pageSize)), page_size: pageSize },
      });
    }

    json(res, 404, { error: 'not_found' });
  });

  return {
    alerts,
    state,
    inject,
    credentials: { clientId, clientSecret },
    /** @returns {Promise<string>} base URL */
    start(port = 0) {
        return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
        const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
        resolve(`http://127.0.0.1:${addr.port}`);
      }));
    },
    stop() { return new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve(undefined)); }); },
  };
}
