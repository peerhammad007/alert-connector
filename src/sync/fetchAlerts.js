// Incremental sync: fetch pages, process alerts, keep a checkpoint and a watermark.
// Run tests with: node --test test/fetchAlerts.test.js
import { request } from '../client/http.js';
import { readFile, writeFile, rename, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {Object} Alert
 * @property {string} id
 * @property {string} last_activity_timestamp ISO string
 */

/**
 * STEP 1: Fetch and yield one page at a time. This function does HTTP only;
 * it does not write files or process individual alerts.
 *
 * @param {{baseUrl: string, getToken: () => Promise<string>, since?: string | null,
 *          startPage?: number, pageSize?: number, http?: typeof request}} opts
 * @returns {AsyncGenerator<{page: number, totalPages: number, alerts: Alert[]}>}
 */
export async function* fetchAlertPages(opts) {
  const {
    baseUrl,
    getToken,
    since = null,
    startPage = 1,
    pageSize = 50,
    http = request,
  } = opts;

  if (!Number.isInteger(startPage) || startPage < 1) {
    throw new RangeError('startPage must be a positive integer');
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError('pageSize must be a positive integer');
  }

  let page = startPage;

  while (true) {
    // URL handles query-string escaping for us, including timestamps.
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/alerts`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('page_size', String(pageSize));

    if (since) {
      url.searchParams.set('last_activity_timestamp', since);
    }

    // Ask auth for a token, then attach it to this API request.
    const token = await getToken();
    const response = await http(url.toString(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Fetching alerts failed with status ${response.status}`);
    }

    const payload = await response.json();
    const alerts = payload.alerts;
    const totalPages = Number(payload.metadata?.total_pages);

    if (!Array.isArray(alerts)) {
      throw new Error('Alerts response did not contain an alerts array');
    }
    if (!Number.isInteger(totalPages) || totalPages < 1) {
      throw new Error('Alerts response contained invalid metadata.total_pages');
    }

    // Yield control to the caller after each page instead of loading everything at once.
    yield { page, totalPages, alerts };

    // Stop when the API says we reached the last page, or gives us an empty page.
    if (alerts.length === 0 || page >= totalPages) {
      return;
    }

    page += 1;
  }
}

/**
 * STEP 2: Fetch and process alerts while maintaining a resumable checkpoint.
 *
 * State file shape:
 *   { watermark: string | null,
 *     checkpoint: { since: string | null, nextPage: number, maxSeen: string | null } | null }
 *
 * @param {{baseUrl: string, getToken: () => Promise<string>, statePath: string,
 *          deadLetterPath: string, processAlert: (alert: Alert) => Promise<void> | void,
 *          pageSize?: number, http?: typeof request}} opts
 * @returns {Promise<{pages: number, processed: number, deadLettered: number, watermark: string | null}>}
 */
export async function runSync(opts) {
  const {
    statePath,
    deadLetterPath,
    processAlert,
    pageSize = 50,
    http = request,
  } = opts;

  // Read the last successful sync state. No file means this is the first run.
  async function loadState() {
    try {
      const contents = await readFile(statePath, 'utf8');
      return JSON.parse(contents);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { watermark: null, checkpoint: null };
      }
      throw error;
    }
  }

  // Save safely: write a temporary file, then rename it over the state file.
  async function saveState(state) {
    await mkdir(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(state, null, 2), 'utf8');
    await rename(temporaryPath, statePath);
  }

  // Store a failed alert as one JSON object per line (JSONL).
  async function saveDeadLetter(alert, error) {
    await mkdir(path.dirname(deadLetterPath), { recursive: true });
    const entry = {
      alert,
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    };
    await appendFile(deadLetterPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  const state = await loadState();

  // Resume the interrupted run when a checkpoint exists. Otherwise start
  // from the last completed watermark and begin at page 1.
  const checkpoint = state.checkpoint;
  const since = checkpoint ? checkpoint.since : state.watermark ?? null;
  const startPage = checkpoint ? checkpoint.nextPage : 1;
  let maxSeen = checkpoint ? checkpoint.maxSeen : null;

  let pages = 0;
  let processed = 0;
  let deadLettered = 0;

  for await (const result of fetchAlertPages({
    baseUrl: opts.baseUrl,
    getToken: opts.getToken,
    since,
    startPage,
    pageSize,
    http,
  })) {
    pages += 1;

    for (const alert of result.alerts) {
      try {
        await processAlert(alert);
        processed += 1;
      } catch (error) {
        // A bad individual alert should not prevent later alerts from running.
        await saveDeadLetter(alert, error);
        deadLettered += 1;
      }

      // Track the newest timestamp even for a dead-lettered alert, so it
      // doesn't get fetched forever on every subsequent sync.
      if (
        typeof alert.last_activity_timestamp === 'string' &&
        (maxSeen === null || alert.last_activity_timestamp > maxSeen)
      ) {
        maxSeen = alert.last_activity_timestamp;
      }
    }

    // Checkpoint only after the entire page has been handled. If a later
    // page fails, the next run can resume from the following page.
    await saveState({
      watermark: state.watermark ?? null,
      checkpoint: {
        since,
        nextPage: result.page + 1,
        maxSeen,
      },
    });
  }

  // We reached the end of pagination. Only now advance the watermark and
  // clear the checkpoint. A failed fetch above leaves the prior checkpoint intact.
  const watermark = maxSeen ?? state.watermark ?? null;
  await saveState({
    watermark,
    checkpoint: null,
  });

  return { pages, processed, deadLettered, watermark };
}
