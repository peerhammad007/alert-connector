// OAuth2 client-credentials with a token cache that survives restarts.
// Run tests with: node --test test/auth.test.js
import { request } from './http.js';
// Needed for STEP 2 and 3 (reading and writing the state file):
// import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
// import path from 'node:path';

/**
 * Thrown when the token endpoint told us to back off and that time has not passed yet.
 * Callers can catch it and decide to skip this run instead of crashing.
 */
export class TokenBackoffError extends Error {
  /** @param {number} notBefore epoch ms when we may ask again */
  constructor(notBefore) {
    super(`Token endpoint backoff until ${new Date(notBefore).toISOString()}`);
    this.name = 'TokenBackoffError';
    this.notBefore = notBefore;
  }
}

/**
 * State file shape (JSON): { accessToken?: string, expiresAt?: number, notBefore?: number }
 *
 * @typedef {Object} AuthOptions
 * @property {string} baseUrl
 * @property {string} clientId
 * @property {string} clientSecret
 * @property {string} statePath            e.g. 'state/token.json'
 * @property {() => number} [now]          injectable clock (epoch ms)
 * @property {typeof request} [http]       injectable, defaults to request() from http.js
 * @property {number} [safetyMs]           treat token as expired this long before it really is (default 5 min)
 */

/** @param {AuthOptions} opts @returns {{getToken: () => Promise<string>}} */
export function createAuth(opts) {
  // getToken() does this, in order:
  //
  // STEP 1: memory/file cache hit. Load state (missing file = empty state). If accessToken exists and
  //         now() < expiresAt - safetyMs, return it. No network call.
  // STEP 2: negative cache. If state.notBefore > now(), throw new TokenBackoffError(state.notBefore).
  //         No network call. (This protects the 5-tokens-per-hour limit.)
  // STEP 3: ask for a new token: POST {baseUrl}/oauth/token, JSON body
  //         { client_id, client_secret, audience: 'doppel-external', grant_type: 'client_credentials' }.
  //         IMPORTANT: call http(url, options, { maxRetries: 0 }). Do NOT let request() retry a 429 here;
  //         instead:
  //           - 429: notBefore = now() + parseRetryAfter(...) (fallback 60 s). Save it, throw TokenBackoffError.
  //           - other non-2xx: throw an Error with the status.
  //           - 200: expiresAt = now() + expires_in * 1000. Save { accessToken, expiresAt } (clear notBefore). Return it.
  // Saving: mkdir the folder, write to `${statePath}.tmp`, then rename() over statePath (so a crash never leaves half a file).
  return {
    async getToken() {
      throw new Error('TODO');
    },
  };
}
