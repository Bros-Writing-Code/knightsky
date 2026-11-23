// @ts-check
/**
 * opponentListener.js — watches the opponent's game record and their rejections of ours.
 *
 * Transport only: it reports each new version of the opponent's record (a record update)
 * and each rejection that points at the current version of our record, exactly as fetched.
 * Checking moves, clocks and results is the validator's job.
 *
 * It polls the opponent's PDS for now. Jetstream can replace the polling later without
 * changing the callbacks.
 */
import { Lexicons } from '@atproto/lexicon';
import gameLexicon from './lexicons/app/knightsky/game.json';
import rejectLexicon from './lexicons/app/knightsky/reject.json';
import strongRefLexicon from './lexicons/com/atproto/repo/strongRef.json';

const GAME = 'app.knightsky.game';
const REJECT = 'app.knightsky.reject';
const POLL_INTERVAL_MS = 1000;
const MAX_BACKOFF_MS = 30000;
// RateLimit-Reset comes from the opponent's PDS, so a far-off reset must not stall the listener.
const MAX_RATE_LIMIT_WAIT_MS = 5 * 60 * 1000;
const PAGE_LIMIT = 50;
const PLC_DIRECTORY = 'https://plc.directory';
const AT_URI = /^at:\/\/(did:[a-z]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9.-]+)\/([a-zA-Z0-9._~:-]+)$/;
const DID = /^did:[a-z]+:[a-zA-Z0-9._:%-]+$/;

// The opponent's records are untrusted, so every record is checked before it is reported.
// JSON imports are typed loosely (`lexicon: number`, not `1`), hence the cast.
const lexicons = new Lexicons(
  /** @type {import('@atproto/lexicon').LexiconDoc[]} */ (
    /** @type {unknown} */ ([strongRefLexicon, gameLexicon, rejectLexicon])
  ),
);

/**
 * @typedef {{ uri: string, cid: string, record: any, seenAt: number }} RecordVersion
 *   seenAt is when this client noticed the version, in epoch milliseconds.
 * @typedef {{ uri: string, cid: string, value: any }} FetchedRecord
 *   A record as the PDS returned it. `value` is untrusted until it passes the lexicon check.
 * @typedef {Error & {
 *   code: string, status?: number, resetAt?: number, uri?: string, cid?: string, did?: string
 * }} ListenerError
 * @typedef {{
 *   myRecordUri: string,
 *   opponentRecordUri?: string,
 *   opponentDid?: string,
 *   onUpdate: (update: RecordVersion) => void,
 *   onRejection: (rejection: RecordVersion) => void,
 *   onError: (error: ListenerError) => void,
 *   fetch?: typeof fetch,
 * }} WatchOptions
 * @typedef {{
 *   myUri: string,
 *   myDid: string,
 *   myRkey: string,
 *   opponentDid: string,
 *   opponentUri: string | null,
 *   onUpdate: WatchOptions['onUpdate'],
 *   onRejection: WatchOptions['onRejection'],
 *   onError: WatchOptions['onError'],
 *   fetch: typeof fetch,
 *   controller: AbortController,
 *   stopped: boolean,
 *   timer: ReturnType<typeof setTimeout> | undefined,
 *   failures: number,
 *   pdsByDid: Map<string, Promise<string>>,
 *   lastGameCid: string | null,
 *   missingReported: boolean,
 *   seenRejections: Set<string>,
 *   reportedInvalid: Set<string>,
 * }} Context
 */

/**
 * Starts watching the opponent. Pass opponentRecordUri when you accepted a challenge, or
 * opponentDid when you sent it; the listener then finds the opponent's acceptance first.
 *
 * Errors carry a `code`: PdsResolutionFailed, NetworkError, RateLimited, HttpError,
 * RecordNotFound, InvalidRecord or UnexpectedError (anything else, e.g. a malformed response;
 * the original error is its `cause`). Polling continues after every error; only stop() ends it.
 *
 * - myRecordUri: AT-URI of your own app.knightsky.game record.
 * - opponentRecordUri: AT-URI of the opponent's game record, or
 * - opponentDid: the opponent's DID, when their record is not known yet.
 * - onUpdate: a new version of the opponent's record.
 * - onRejection: the opponent rejected the current version of your record.
 * - fetch: defaults to globalThis.fetch; tests pass a stub.
 *
 * @param {WatchOptions} options
 * @returns {() => void} stop
 */
export function watchOpponentGame(options) {
  const ctx = createContext(options);
  poll(ctx);
  return () => {
    ctx.stopped = true;
    ctx.controller.abort();
    clearTimeout(ctx.timer);
  };
}

/**
 * @param {WatchOptions} options
 * @returns {Context}
 */
function createContext(options) {
  const { myRecordUri, opponentRecordUri, opponentDid, onUpdate, onRejection, onError } =
    options ?? {};
  for (const [name, callback] of Object.entries({ onUpdate, onRejection, onError })) {
    if (typeof callback !== 'function') {
      throw new TypeError(`watchOpponentGame: ${name} must be a function`);
    }
  }
  const mine = parseGameUri(myRecordUri, 'myRecordUri');
  if ((opponentRecordUri === undefined) === (opponentDid === undefined)) {
    throw new TypeError('watchOpponentGame: pass exactly one of opponentRecordUri or opponentDid');
  }
  if (opponentDid !== undefined && !DID.test(opponentDid)) {
    throw new TypeError('watchOpponentGame: opponentDid must be a DID');
  }
  const theirs = opponentRecordUri && parseGameUri(opponentRecordUri, 'opponentRecordUri');
  return {
    myUri: myRecordUri,
    myDid: mine.did,
    myRkey: mine.rkey,
    opponentDid: theirs ? theirs.did : /** @type {string} */ (opponentDid),
    opponentUri: theirs ? opponentRecordUri : null,
    onUpdate,
    onRejection,
    onError,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    controller: new AbortController(),
    stopped: false,
    timer: undefined,
    failures: 0,
    pdsByDid: new Map(),
    lastGameCid: null,
    missingReported: false,
    seenRejections: new Set(),
    reportedInvalid: new Set(),
  };
}

/**
 * @param {unknown} uri
 * @param {string} name - Option name, for the error message.
 */
function parseGameUri(uri, name) {
  const match = typeof uri === 'string' ? AT_URI.exec(uri) : null;
  if (!match || match[2] !== GAME) {
    throw new TypeError(`watchOpponentGame: ${name} must be an AT-URI of an ${GAME} record`);
  }
  return { did: match[1], rkey: match[3] };
}

// One poll checks the game record and the rejections in parallel, then schedules the next one.
// A setTimeout chain, not setInterval, so a slow PDS never has requests piling up.
/** @param {Context} ctx */
async function poll(ctx) {
  const results = await Promise.allSettled([pollGame(ctx), pollRejections(ctx)]);
  if (ctx.stopped) {
    return;
  }
  /** @type {ListenerError[]} */
  const errors = results.flatMap((r) =>
    r.status === 'rejected' ? [asListenerError(r.reason)] : [],
  );
  errors.forEach((error) => emit(ctx, ctx.onError, error));
  ctx.failures = errors.length ? ctx.failures + 1 : 0;
  ctx.timer = setTimeout(() => poll(ctx), nextDelay(ctx.failures, errors));
}

/**
 * @param {number} failures - Polls in a row that had an error.
 * @param {ListenerError[]} errors
 */
function nextDelay(failures, errors) {
  if (!failures) {
    return POLL_INTERVAL_MS;
  }
  const backoff = Math.min(POLL_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS);
  const resetAt = Math.max(0, ...errors.map((e) => e.resetAt ?? 0));
  return Math.max(backoff, Math.min(resetAt - Date.now(), MAX_RATE_LIMIT_WAIT_MS));
}

/**
 * Keeps the promise that every reported error has a `code`.
 *
 * @param {unknown} error
 * @returns {ListenerError}
 */
function asListenerError(error) {
  if (error instanceof Error && typeof (/** @type {any} */ (error).code) === 'string') {
    return /** @type {ListenerError} */ (error);
  }
  return listenerError('UnexpectedError', 'Unexpected error while polling', { cause: error });
}

/** @param {Context} ctx */
async function pollGame(ctx) {
  if (!ctx.opponentUri) {
    const acceptance = await findAcceptance(ctx);
    if (acceptance) {
      ctx.opponentUri = acceptance.uri;
      handleGameVersion(ctx, acceptance);
    }
    return;
  }
  let version;
  try {
    version = await getRecord(ctx, ctx.opponentUri);
  } catch (caught) {
    const error = /** @type {ListenerError} */ (caught);
    if (error.code !== 'RecordNotFound') {
      throw error;
    }
    // Reported once, and not a failure: polling carries on at the normal rate. Forgetting the
    // CID means the record is reported again if it is written back.
    ctx.lastGameCid = null;
    if (!ctx.missingReported) {
      ctx.missingReported = true;
      emit(ctx, ctx.onError, error);
    }
    return;
  }
  ctx.missingReported = false;
  handleGameVersion(ctx, version);
}

/**
 * @param {Context} ctx
 * @param {FetchedRecord} version
 */
function handleGameVersion(ctx, { uri, cid, value }) {
  if (cid === ctx.lastGameCid) {
    return;
  }
  ctx.lastGameCid = cid;
  if (isValid(ctx, GAME, { uri, cid, value })) {
    emit(ctx, ctx.onUpdate, { uri, cid, record: value, seenAt: Date.now() });
  }
}

/**
 * Finds the opponent's acceptance of our invitation: their game record whose challenge points at
 * our record and whose opponent is us. If there are several, the oldest (lowest TID) wins.
 * Acceptances are created after the invitation, so paging (newest first) stops at our own TID.
 * Clock skew between PDSes could hide an acceptance made in the same instant; we accept that.
 *
 * @param {Context} ctx
 */
async function findAcceptance(ctx) {
  /** @type {FetchedRecord | null} */
  let oldest = null;
  for await (const version of listNewerThan(ctx, ctx.opponentDid, GAME, ctx.myRkey)) {
    const { value } = version;
    if (value?.challenge?.uri !== ctx.myUri || value?.opponent !== ctx.myDid) {
      continue;
    }
    if (isValid(ctx, GAME, version)) {
      oldest = version;
    }
  }
  return oldest;
}

/**
 * @param {Context} ctx
 * @param {string} did
 * @param {string} collection
 * @param {string} rkey - Stop at records with this rkey or older.
 */
async function* listNewerThan(ctx, did, collection, rkey) {
  for await (const version of listRecords(ctx, did, collection)) {
    if (rkeyOf(version.uri) <= rkey) {
      return;
    }
    yield version;
  }
}

/**
 * Reports rejections that point at the current version of our record. Stale ones (for a version
 * we have since replaced) and ones about other records are dropped. Our own record is only
 * fetched when there is a new rejection to compare against.
 *
 * @param {Context} ctx
 */
async function pollRejections(ctx) {
  /** @type {FetchedRecord[]} */
  const unseen = [];
  // A rejection of our record is newer than our record, so paging stops at our TID.
  for await (const version of listNewerThan(ctx, ctx.opponentDid, REJECT, ctx.myRkey)) {
    if (ctx.seenRejections.has(version.uri)) {
      break;
    }
    unseen.push(version);
  }
  let myCid;
  for (const version of unseen.reverse()) {
    if (version.value?.subject?.uri === ctx.myUri && isValid(ctx, REJECT, version)) {
      // If this fetch fails, the rejection stays unseen and is checked again next poll.
      myCid ??= (await getRecord(ctx, ctx.myUri)).cid;
      if (version.value.subject.cid === myCid) {
        const { uri, cid, value } = version;
        emit(ctx, ctx.onRejection, { uri, cid, record: value, seenAt: Date.now() });
      }
    }
    ctx.seenRejections.add(version.uri);
  }
}

/**
 * @param {Context} ctx
 * @param {string} collection
 * @param {FetchedRecord} version
 */
function isValid(ctx, collection, { uri, cid, value }) {
  try {
    lexicons.assertValidRecord(collection, value);
    return true;
  } catch (cause) {
    const key = `${uri} ${cid}`;
    if (!ctx.reportedInvalid.has(key)) {
      ctx.reportedInvalid.add(key);
      emit(
        ctx,
        ctx.onError,
        listenerError('InvalidRecord', `${uri} does not match the ${collection} lexicon`, {
          cause,
          uri,
          cid,
        }),
      );
    }
    return false;
  }
}

/**
 * @param {Context} ctx
 * @param {string} uri - Already checked against AT_URI.
 * @returns {Promise<FetchedRecord>}
 */
async function getRecord(ctx, uri) {
  const [, did, collection, rkey] = /** @type {RegExpExecArray} */ (AT_URI.exec(uri));
  const body = await xrpc(ctx, did, 'com.atproto.repo.getRecord', { repo: did, collection, rkey });
  // The URI we asked for, not the one in the body: the PDS is untrusted.
  return { uri, cid: body.cid, value: body.value };
}

/**
 * Every record in a collection, newest first, fetched a page at a time as the caller needs them.
 * Records whose URI is not in this repo and collection are dropped, since the PDS is untrusted.
 *
 * @param {Context} ctx
 * @param {string} did
 * @param {string} collection
 * @returns {AsyncGenerator<FetchedRecord>}
 */
async function* listRecords(ctx, did, collection) {
  /** @type {string | undefined} */
  let cursor;
  do {
    /** @type {Record<string, string>} */
    const params = { repo: did, collection, limit: String(PAGE_LIMIT) };
    if (cursor) {
      params.cursor = cursor;
    }
    const body = await xrpc(ctx, did, 'com.atproto.repo.listRecords', params);
    const records = Array.isArray(body.records) ? body.records : [];
    for (const record of records) {
      if (isRecordIn(record, did, collection)) {
        yield record;
      }
    }
    // A cursor that does not move would page forever.
    const next = records.length && typeof body.cursor === 'string' ? body.cursor : undefined;
    cursor = next === cursor ? undefined : next;
  } while (cursor);
}

/**
 * @param {any} record
 * @param {string} did
 * @param {string} collection
 */
function isRecordIn(record, did, collection) {
  const match = typeof record?.uri === 'string' ? AT_URI.exec(record.uri) : null;
  return match !== null && match[1] === did && match[2] === collection;
}

/** @param {string} uri */
function rkeyOf(uri) {
  return uri.slice(uri.lastIndexOf('/') + 1);
}

/**
 * @param {Context} ctx
 * @param {string} did - Whose PDS to ask.
 * @param {string} method - XRPC method NSID.
 * @param {Record<string, string>} params
 * @returns {Promise<any>} The response body.
 */
async function xrpc(ctx, did, method, params) {
  const url = new URL(`/xrpc/${method}`, await pdsFor(ctx, did));
  url.search = new URLSearchParams(params).toString();
  const response = await send(ctx, url);
  const body = await response.json().catch(() => ({}));
  if (response.ok) {
    return body;
  }
  if (response.status === 429) {
    throw listenerError('RateLimited', `${url.host} is rate limiting requests`, {
      status: 429,
      resetAt: rateLimitReset(response),
    });
  }
  if (response.status === 400 && body.error === 'RecordNotFound') {
    const uri = `at://${params.repo}/${params.collection}/${params.rkey}`;
    throw listenerError('RecordNotFound', `${uri} does not exist`, { status: 400, uri });
  }
  throw listenerError('HttpError', `${method} failed (${response.status})`, {
    status: response.status,
  });
}

/**
 * @param {Context} ctx
 * @param {URL} url
 */
async function send(ctx, url) {
  try {
    return await ctx.fetch(url.href, { signal: ctx.controller.signal });
  } catch (cause) {
    throw listenerError('NetworkError', `Could not reach ${url.host}`, { cause });
  }
}

// Bluesky's PDS sends RateLimit-Reset as epoch seconds. Browsers can't read Retry-After from it.
/**
 * @param {Response} response
 * @returns {number | undefined} Epoch milliseconds.
 */
function rateLimitReset(response) {
  const seconds = Number(response.headers.get('RateLimit-Reset'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

// Cached for the listener's lifetime. A failed lookup is forgotten so the next poll retries it.
/**
 * @param {Context} ctx
 * @param {string} did
 * @returns {Promise<string>} The PDS URL.
 */
function pdsFor(ctx, did) {
  if (!ctx.pdsByDid.has(did)) {
    const lookup = resolvePds(ctx, did);
    lookup.catch(() => ctx.pdsByDid.delete(did));
    ctx.pdsByDid.set(did, lookup);
  }
  return /** @type {Promise<string>} */ (ctx.pdsByDid.get(did));
}

/**
 * Looks up a DID's PDS from its DID document (did:plc via plc.directory, did:web via
 * /.well-known/did.json). The OAuth client's identity resolver can replace this later.
 *
 * @param {Context} ctx
 * @param {string} did
 * @returns {Promise<string>}
 */
async function resolvePds(ctx, did) {
  /** @type {(reason: string, cause?: unknown) => ListenerError} */
  const fail = (reason, cause) =>
    listenerError('PdsResolutionFailed', `Could not find the PDS for ${did}: ${reason}`, {
      cause,
      did,
    });
  let documentUrl;
  if (did.startsWith('did:plc:')) {
    documentUrl = `${PLC_DIRECTORY}/${did}`;
  } else if (did.startsWith('did:web:')) {
    documentUrl = `https://${decodeURIComponent(did.slice('did:web:'.length))}/.well-known/did.json`;
  } else {
    throw fail('unsupported DID method');
  }
  let document;
  try {
    const response = await ctx.fetch(documentUrl, { signal: ctx.controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    document = await response.json();
  } catch (cause) {
    throw fail('DID document lookup failed', cause);
  }
  const service = document?.service?.find?.(
    (/** @type {any} */ s) => s?.id === '#atproto_pds' || s?.id === `${did}#atproto_pds`,
  );
  if (typeof service?.serviceEndpoint !== 'string' || !isUrl(service.serviceEndpoint)) {
    throw fail('no #atproto_pds service in the DID document');
  }
  return service.serviceEndpoint;
}

/** @param {string} text */
function isUrl(text) {
  try {
    return Boolean(new URL(text));
  } catch {
    return false;
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {{ cause?: unknown } & Omit<Partial<ListenerError>, 'cause'>} [extra]
 * @returns {ListenerError}
 */
function listenerError(code, message, extra = {}) {
  const { cause, ...fields } = extra;
  const error = new Error(message, cause === undefined ? undefined : { cause });
  return Object.assign(error, { code }, fields);
}

// Nothing is reported after stop(), even from a response that was already on its way.
// A throwing callback is the caller's bug; log it rather than let it stop the listener.
/**
 * @template T
 * @param {Context} ctx
 * @param {(value: T) => void} callback
 * @param {T} value
 */
function emit(ctx, callback, value) {
  if (ctx.stopped) {
    return;
  }
  try {
    callback(value);
  } catch (error) {
    console.error(error);
  }
}
