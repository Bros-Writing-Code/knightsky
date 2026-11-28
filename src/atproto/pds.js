// @ts-check
/**
 * pds.js — public, unauthenticated reads from any account's PDS, and the coded errors the
 * atproto layer reports to the UI.
 */
import { createDidResolver, extractPdsUrl } from '@atproto-labs/did-resolver';

export const GAME = 'app.knightsky.game';
export const REJECT = 'app.knightsky.reject';
export const AT_URI =
  /^at:\/\/(did:[a-z]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9.-]+)\/([a-zA-Z0-9._~:-]+)$/;
export const DID = /^did:[a-z]+:[a-zA-Z0-9._:%-]+$/;
const PAGE_LIMIT = 50;

/**
 * @typedef {{ uri: string, cid: string, value: any }} FetchedRecord
 * @typedef {Error & {
 *   code: string, status?: number, resetAt?: number, uri?: string, cid?: string, did?: string
 * }} CodedError
 * @typedef {{
 *   getRecord: (uri: string) => Promise<FetchedRecord>,
 *   listRecords: (did: string, collection: string) => AsyncGenerator<FetchedRecord>,
 * }} PdsReader
 */

/**
 * Creates a reader for public records. PDS lookups are cached per DID, so many games against the
 * same opponent share one lookup. Every request is aborted when `signal` aborts.
 *
 * Errors are CodedErrors: PdsResolutionFailed, NetworkError, RateLimited, HttpError or
 * RecordNotFound.
 *
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal }} [options]
 * @returns {PdsReader}
 */
export function createPdsReader({ fetch, signal } = {}) {
  /** @type {Reader} */
  const reader = {
    fetch: fetch ?? ((input, init) => globalThis.fetch(input, init)),
    signal,
    didResolver: createDidResolver({ fetch }),
    pdsByDid: new Map(),
  };
  return {
    async getRecord(uri) {
      const { did, collection, rkey } = /** @type {NonNullable<ReturnType<typeof parseAtUri>>} */ (
        parseAtUri(uri)
      );
      const params = { repo: did, collection, rkey };
      const body = await xrpc(reader, did, 'com.atproto.repo.getRecord', params);
      return { uri, cid: body.cid, value: body.value };
    },
    listRecords: (did, collection) => listRecords(reader, did, collection),
  };
}

/**
 * @typedef {{
 *   fetch: typeof fetch,
 *   signal: AbortSignal | undefined,
 *   didResolver: ReturnType<typeof createDidResolver>,
 *   pdsByDid: Map<string, Promise<URL>>,
 * }} Reader
 */

/**
 * Yields a collection's records newest first, one page at a time so callers can stop early.
 * Records outside the requested repo or collection are skipped because the response is
 * untrusted, and a repeated cursor ends the loop so a misbehaving PDS cannot make it spin.
 *
 * @param {Reader} reader
 * @param {string} did
 * @param {string} collection
 * @returns {AsyncGenerator<FetchedRecord>}
 */
async function* listRecords(reader, did, collection) {
  /** @type {string | undefined} */
  let cursor;
  do {
    /** @type {Record<string, string>} */
    const params = { repo: did, collection, limit: String(PAGE_LIMIT) };
    if (cursor) {
      params.cursor = cursor;
    }
    const body = await xrpc(reader, did, 'com.atproto.repo.listRecords', params);
    const records = Array.isArray(body.records) ? body.records : [];
    for (const record of records) {
      if (isRecordIn(record, did, collection)) {
        yield record;
      }
    }
    const next = records.length && typeof body.cursor === 'string' ? body.cursor : undefined;
    cursor = next === cursor ? undefined : next;
  } while (cursor);
}

/**
 * Makes an XRPC GET request to the PDS that hosts `did` and returns the JSON body.
 *
 * @param {Reader} reader
 * @param {string} did DID whose PDS receives the request
 * @param {string} method full XRPC method NSID
 * @param {Record<string, string>} params
 */
async function xrpc(reader, did, method, params) {
  const url = new URL(`/xrpc/${method}`, await pdsFor(reader, did));
  url.search = new URLSearchParams(params).toString();
  let response;
  try {
    response = await reader.fetch(url.href, { signal: reader.signal });
  } catch (cause) {
    throw codedError('NetworkError', `Could not reach ${url.host}`, { cause });
  }
  const body = await response.json().catch(() => ({}));
  if (response.ok) {
    return body;
  }
  if (response.status === 429) {
    throw codedError('RateLimited', `${url.host} is rate limiting requests`, {
      status: 429,
      resetAt: rateLimitReset(response),
    });
  }
  if (response.status === 400 && body.error === 'RecordNotFound') {
    const uri = `at://${params.repo}/${params.collection}/${params.rkey}`;
    throw codedError('RecordNotFound', `${uri} does not exist`, { status: 400, uri });
  }
  throw codedError('HttpError', `${method} failed (${response.status})`, {
    status: response.status,
  });
}

/**
 * The PDS URL for a DID. The promise is cached, so concurrent callers share one lookup; a failed
 * lookup is forgotten so the next call tries again.
 *
 * @param {Reader} reader
 * @param {string} did
 */
function pdsFor(reader, did) {
  if (!reader.pdsByDid.has(did)) {
    const lookup = resolvePds(reader, did);
    lookup.catch(() => reader.pdsByDid.delete(did));
    reader.pdsByDid.set(did, lookup);
  }
  return /** @type {Promise<URL>} */ (reader.pdsByDid.get(did));
}

/**
 * @param {Reader} reader
 * @param {string} did
 */
async function resolvePds(reader, did) {
  try {
    const document = await reader.didResolver.resolve(/** @type {any} */ (did), {
      signal: reader.signal,
    });
    return extractPdsUrl(/** @type {any} */ (document));
  } catch (cause) {
    throw codedError('PdsResolutionFailed', `Could not find the PDS for ${did}`, { cause, did });
  }
}

/**
 * Splits an AT-URI into its DID, collection and record key, or returns null if it is not one.
 *
 * @param {unknown} uri
 * @returns {{ did: string, collection: string, rkey: string } | null}
 */
export function parseAtUri(uri) {
  const match = typeof uri === 'string' ? AT_URI.exec(uri) : null;
  return match && { did: match[1], collection: match[2], rkey: match[3] };
}

/**
 * Creates an Error with a `code` and any extra fields (status, uri, …) that the UI can read.
 *
 * @param {string} code
 * @param {string} message
 * @param {{ cause?: unknown } & Omit<Partial<CodedError>, 'cause'>} [extra]
 * @returns {CodedError}
 */
export function codedError(code, message, extra = {}) {
  const { cause, ...fields } = extra;
  const error = new Error(message, cause === undefined ? undefined : { cause });
  return Object.assign(error, { code }, fields);
}

/**
 * Passes CodedErrors through and wraps anything else (a bug, a malformed response) as an
 * UnexpectedError, so the UI always gets a `code`.
 *
 * @param {unknown} error
 * @returns {CodedError}
 */
export function asCodedError(error) {
  if (error instanceof Error && typeof (/** @type {any} */ (error).code) === 'string') {
    return /** @type {CodedError} */ (error);
  }
  return codedError('UnexpectedError', 'Unexpected error', { cause: error });
}

/**
 * @param {any} record
 * @param {string} did
 * @param {string} collection
 */
function isRecordIn(record, did, collection) {
  const parts = parseAtUri(record?.uri);
  return parts !== null && parts.did === did && parts.collection === collection;
}

/**
 * Reads the RateLimit-Reset header (seconds since the Unix epoch) in milliseconds.
 *
 * @param {Response} response
 */
function rateLimitReset(response) {
  const seconds = Number(response.headers.get('RateLimit-Reset'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}
