// @ts-check
// YOUR turn: make these pass by implementing src/client/http.js, auth.js, sync/fetchAlerts.js.
import test from 'node:test';

// http.js
test.todo('retries 503 then succeeds (and counts attempts)');
test.todo('honours Retry-After on 429 (does not retry sooner)');
test.todo('never retries 400/401/403/404');
test.todo('times out a slow response and retries, then gives up after maxRetries');
test.todo('backoff delay grows exponentially and is jittered (inject a fake sleep + random)');
test.todo('token bucket: 101st request in a minute waits (inject a fake clock)');
// auth.js
test.todo('reuses a cached token across two getToken() calls (1 token request)');
test.todo('persists/reloads token so a second process run reuses it');
test.todo('on token 429, remembers "not before" and does not call the endpoint again');
// fetchAlerts.js
test.todo('pages through all alerts end to end');
test.todo('passes watermark as last_activity_timestamp (inclusive) and tolerates the re-fetched boundary item');
test.todo('mid-run failure: resume from checkpoint without refetching completed pages');
test.todo('watermark only advances after a fully processed run, to a value actually seen');
test.todo('poison alert goes to dead-letter file and does not block the watermark forever');
