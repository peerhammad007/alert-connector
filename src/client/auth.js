// OAuth2 client-credentials with a token cache that survives restarts.
// Run tests with: node --test test/auth.test.js
import { request, parseRetryAfter } from './http.js';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

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
 const now = opts.now ?? Date.now;
 const http = opts.http ?? request;
 const safetyMs = opts.safetyMs ?? 5 * 60 * 1000;

 // Read the saved state. A missing file simply means we have no cached token yet.
 async function loadState() {
   try {
     const contents = await readFile(opts.statePath, 'utf8');
     return JSON.parse(contents);
   } catch (error) {
     if (error.code === 'ENOENT') return {};
     throw error;
   }
 }

 // Write to a temporary file first, then rename it into place.
 // This avoids leaving a partly-written token file if the process stops mid-write.
 async function saveState(state) {
   await mkdir(path.dirname(opts.statePath), { recursive: true });
   const temporaryPath = `${opts.statePath}.tmp`;
   await writeFile(temporaryPath, JSON.stringify(state, null, 2), 'utf8');
   await rename(temporaryPath, opts.statePath);
 }

 return {
   async getToken() {
     const state = await loadState();
     const currentTime = now();

     // STEP 1: Reuse a token if it is still valid beyond the safety margin.
     if (
       typeof state.accessToken === 'string' &&
       Number.isFinite(state.expiresAt) &&
       currentTime < state.expiresAt - safetyMs
     ) {
       return state.accessToken;
     }

     // STEP 2: Respect a previous 429 response without making another network call.
     if (Number.isFinite(state.notBefore) && state.notBefore > currentTime) {
       throw new TokenBackoffError(state.notBefore);
     }

     // STEP 3: Request a fresh OAuth token. maxRetries: 0 is important:
     // we handle 429 here so that we can save the server's retry time.
     const url = `${opts.baseUrl.replace(/\/+$/, '')}/oauth/token`;
     const response = await http(
       url,
       {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
           client_id: opts.clientId,
           client_secret: opts.clientSecret,
           audience: 'doppel-external',
           grant_type: 'client_credentials',
         }),
       },
       { maxRetries: 0 },
     );

     if (response.status === 429) {
       const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now());
       const notBefore = now() + (retryAfterMs ?? 60_000);

       // Preserve any old token information, but remember when we may ask again.
       await saveState({ ...state, notBefore });
       throw new TokenBackoffError(notBefore);
     }

     if (!response.ok) {
       throw new Error(`Token request failed with status ${response.status}`);
     }

     const payload = await response.json();
     const expiresIn = Number(payload.expires_in);

     if (
       typeof payload.access_token !== 'string' ||
       payload.access_token.length === 0 ||
       !Number.isFinite(expiresIn) ||
       expiresIn <= 0
     ) {
       throw new Error('Token endpoint returned an invalid token response');
     }

     const expiresAt = now() + expiresIn * 1000;

     // Saving only these fields clears any previous notBefore backoff.
     await saveState({
       accessToken: payload.access_token,
       expiresAt,
     });

     return payload.access_token;
   },
 };
}
