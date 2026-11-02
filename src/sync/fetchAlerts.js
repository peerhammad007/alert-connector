// Incremental sync: fetch pages, process alerts, keep a checkpoint and a watermark.
// Run tests with: node --test test/fetchAlerts.test.js
import { request } from '../client/http.js';
// import { readFile, writeFile, rename, mkdir, appendFile } from 'node:fs/promises';

/**
 * @typedef {Object} Alert
 * @property {string} id
 * @property {string} last_activity_timestamp  ISO string
 */

/**
 * STEP 1: yield one page at a time. No file writing here, just HTTP.
 *  - URL: `${baseUrl}/alerts?page=${page}&page_size=${pageSize}` plus
 *         `&last_activity_timestamp=${encodeURIComponent(since)}` when `since` is set.
 *  - Headers: Authorization: `Bearer ${await getToken()}`
 *  - Start at startPage; stop after metadata.total_pages (or an empty page).
 *  - A non-2xx final response should throw (include the status in the message).
 *
 * @param {{baseUrl: string, getToken: () => Promise<string>, since?: string | null, startPage?: number,
 *          pageSize?: number, http?: typeof request}} opts
 * @returns {AsyncGenerator<{page: number, totalPages: number, alerts: Alert[]}>}
 */
export async function* fetchAlertPages(opts) {
  throw new Error('TODO');
}

/**
 * STEP 2: the orchestrator. State file shape (JSON):
 *   { watermark: string | null,
 *     checkpoint: { since: string | null, nextPage: number, maxSeen: string | null } | null }
 *
 * Algorithm:
 *  1. Load state (missing file = { watermark: null, checkpoint: null }).
 *  2. If a checkpoint exists, RESUME: since = checkpoint.since, startPage = checkpoint.nextPage,
 *     maxSeen = checkpoint.maxSeen. Otherwise since = watermark, startPage = 1, maxSeen = null.
 *  3. For each page from fetchAlertPages: for each alert call processAlert(alert).
 *       - If it throws: append { alert, error: message, at: ISO time } as one JSON line to deadLetterPath,
 *         count it in deadLettered, and CONTINUE (policy: dead-letter, don't block).
 *       - Otherwise count it in processed.
 *       - Either way, update maxSeen if alert.last_activity_timestamp is larger.
 *     After the whole page: save the checkpoint { since, nextPage: page + 1, maxSeen }.
 *  4. Only when the loop finishes with no thrown error: save
 *     { watermark: maxSeen ?? watermark, checkpoint: null }.
 *     If fetching throws (network, 5xx after retries), let the error propagate and leave the checkpoint as is.
 *
 * Why the watermark only moves at the end: if it moved early and the run crashed, alerts between
 * the old and new watermark would never be fetched again.
 *
 * @param {{baseUrl: string, getToken: () => Promise<string>, statePath: string, deadLetterPath: string,
 *          processAlert: (alert: Alert) => Promise<void> | void, pageSize?: number, http?: typeof request}} opts
 * @returns {Promise<{pages: number, processed: number, deadLettered: number, watermark: string | null}>}
 */
export async function runSync(opts) {
  throw new Error('TODO');
}
