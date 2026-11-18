// Fake "Doppel-shaped" alert API. Synthetic data only. Shapes are approximate, not the real contract.
import express from 'express';

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
 * Fake alert API built on Express.
 * @param {{seed?: number, count?: number, tokenLimitPerHour?: number, clientId?: string, clientSecret?: string}} [opts]
 */
export function createSourceMock(opts = {}) {
  const { tokenLimitPerHour = 5, clientId = 'test-client', clientSecret = 'test-secret' } = opts;
  const alerts = generateAlerts(opts);

  const state = {
    tokensIssued: /** @type {number[]} */ ([]), // epoch ms of each token issued (for the hourly limit)
    validTokens: new Set(),
    requests: /** @type {{method:string,url:string}[]} */ ([]), // every request, so tests can assert "no refetch"
    failures: { alerts429: 0, alerts503: 0, tokenSlowMs: 0, alertsSlowMs: 0, retryAfterSec: 1, dropFirstAlertAfterPage1: false },
  };

  /** Provoke failures for the next N calls. @param {Partial<typeof state.failures>} partial */
  function inject(partial) { Object.assign(state.failures, partial); }

  const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const app = express();
  app.use(express.json()); // parses JSON bodies into req.body

  // Log every request first, so tests can inspect state.requests.
  app.use((req, _res, next) => {
    state.requests.push({ method: req.method, url: req.originalUrl });
    next();
  });

  // ---- POST /oauth/token ----
  app.post('/oauth/token', async (req, res) => {
    const f = state.failures;
    if (f.tokenSlowMs) await sleep(f.tokenSlowMs);

    const { client_id, client_secret } = req.body ?? {};
    if (client_id !== clientId || client_secret !== clientSecret) {
      return res.status(401).json({ error: 'invalid_client' });
    }

    const now = Date.now();
    state.tokensIssued = state.tokensIssued.filter((t) => now - t < 3600_000);
    if (state.tokensIssued.length >= tokenLimitPerHour) {
      const waitSec = Math.ceil((3600_000 - (now - state.tokensIssued[0])) / 1000);
      return res.status(429).set('Retry-After', String(waitSec)).json({ error: 'token_rate_limited' });
    }

    state.tokensIssued.push(now);
    const token = `tok_${now}_${state.tokensIssued.length}`;
    state.validTokens.add(token);
    res.json({ access_token: token, token_type: 'Bearer', expires_in: 86400 });
  });

  // ---- GET /alerts ----
  app.get('/alerts', async (req, res) => {
    const f = state.failures;

    const bearer = (req.get('authorization') ?? '').replace(/^Bearer /, '');
    if (!state.validTokens.has(bearer)) return res.status(401).json({ error: 'unauthorized' });

    if (f.alertsSlowMs) await sleep(f.alertsSlowMs);
    if (f.alerts429 > 0) { f.alerts429--; return res.status(429).set('Retry-After', String(f.retryAfterSec)).json({ error: 'rate_limited' }); }
    if (f.alerts503 > 0) { f.alerts503--; return res.status(503).json({ error: 'unavailable' }); }

    const page = Number(req.query.page ?? 1);
    const pageSize = Math.min(200, Number(req.query.page_size ?? 50));
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1) {
      return res.status(400).json({ error: 'bad_request' });
    }
    const since = typeof req.query.last_activity_timestamp === 'string' ? req.query.last_activity_timestamp : null;

    let rows = alerts;
    if (since) rows = rows.filter((a) => a.last_activity_timestamp >= since); // inclusive: "at or after"
    // "data changes between page 1 and page 2": drop the first row once page 1 has been served.
    if (f.dropFirstAlertAfterPage1 && page > 1) rows = rows.slice(1);

    const total = rows.length;
    res.json({
      alerts: rows.slice((page - 1) * pageSize, page * pageSize),
      metadata: { count: total, page, total_pages: Math.max(1, Math.ceil(total / pageSize)), page_size: pageSize },
    });
  });

  // Anything else: JSON 404 (Express would otherwise send HTML).
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  // Malformed JSON body etc.
  app.use((/** @type {any} */ err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: 'server_error' });
  });

  /** @type {import('node:http').Server} */
  let server;

  return {
    alerts,
    state,
    inject,
    credentials: { clientId, clientSecret },
    /** @param {number} [port] 0 = any free port @returns {Promise<string>} base URL */
    start(port = 0) {
      return new Promise((resolve) => {
        server = app.listen(port, '127.0.0.1', () => {
          const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
          resolve(`http://127.0.0.1:${addr.port}`);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      });
    },
  };
}