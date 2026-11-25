// @ts-check
/**
 * opponentListener.js — watches the opponent's game record and their rejections of ours.
 *
 * Jetstream carries live repository commits. A one-time PDS read bootstraps the current game,
 * acceptance and rejections; the websocket then delivers subsequent changes.
 */
import { Lexicons } from '@atproto/lexicon';
import gameLexicon from './lexicons/app/knightsky/game.json';
import rejectLexicon from './lexicons/app/knightsky/reject.json';
import strongRefLexicon from './lexicons/com/atproto/repo/strongRef.json';

const GAME = 'app.knightsky.game';
const REJECT = 'app.knightsky.reject';
const JETSTREAM_URL =
  'wss://jetstream.us-west.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents';
const RECONNECT_DELAY_MS = 1000;
const MAX_BACKOFF_MS = 30000;
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
 * @typedef {{ uri: string, cid: string, value: any }} FetchedRecord
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
 *   jetstreamUrl?: string,
 *   webSocket?: typeof WebSocket,
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
 *   webSocket: typeof WebSocket,
 *   jetstreamUrl: string,
 *   controller: AbortController,
 *   stopped: boolean,
 *   socket: WebSocket | null,
 *   reconnectTimer: ReturnType<typeof setTimeout> | undefined,
 *   failures: number,
 *   socketErrorReported: boolean,
 *   initialized: boolean,
 *   ready: boolean,
 *   pendingEvents: any[],
 *   processing: Promise<void>,
 *   eventRetryTimers: Set<ReturnType<typeof setTimeout>>,
 *   cursor: number | undefined,
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
 * the original error is its `cause`). A failed websocket connection is retried until stop().
 *
 * - myRecordUri: AT-URI of your own app.knightsky.game record.
 * - opponentRecordUri: AT-URI of the opponent's game record, or
 * - opponentDid: the opponent's DID, when their record is not known yet.
 * - onUpdate: a new version of the opponent's record.
 * - onRejection: the opponent rejected the current version of your record.
 * - jetstreamUrl: optional Jetstream v2 `subscribeEvents` websocket endpoint.
 * - webSocket: defaults to the browser's WebSocket; tests can inject a stand-in.
 *
 * @param {WatchOptions} options
 * @returns {() => void} stop
 */
export function watchOpponentGame(options) {
  const ctx = createContext(options);
  connect(ctx);
  return () => {
    ctx.stopped = true;
    ctx.controller.abort();
    clearTimeout(ctx.reconnectTimer);
    ctx.eventRetryTimers.forEach(clearTimeout);
    ctx.eventRetryTimers.clear();
    ctx.socket?.close();
    ctx.socket = null;
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
  const { webSocket, jetstreamUrl } = getJetstreamOptions(options);
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
    webSocket,
    jetstreamUrl,
    controller: new AbortController(),
    stopped: false,
    socket: null,
    reconnectTimer: undefined,
    failures: 0,
    socketErrorReported: false,
    initialized: false,
    ready: false,
    pendingEvents: [],
    processing: Promise.resolve(),
    eventRetryTimers: new Set(),
    cursor: undefined,
    pdsByDid: new Map(),
    lastGameCid: null,
    missingReported: false,
    seenRejections: new Set(),
    reportedInvalid: new Set(),
  };
}

/**
 * @param {WatchOptions} options
 * @returns {{ webSocket: typeof WebSocket, jetstreamUrl: string }}
 */
function getJetstreamOptions(options) {
  const jetstreamUrl = options.jetstreamUrl ?? JETSTREAM_URL;
  let parsedJetstreamUrl;
  try {
    parsedJetstreamUrl = new URL(jetstreamUrl);
  } catch {
    throw new TypeError('watchOpponentGame: jetstreamUrl must be a WebSocket URL');
  }
  if (!['ws:', 'wss:'].includes(parsedJetstreamUrl.protocol)) {
    throw new TypeError('watchOpponentGame: jetstreamUrl must use ws: or wss:');
  }
  const webSocket = options.webSocket ?? globalThis.WebSocket;
  if (typeof webSocket !== 'function') {
    throw new TypeError('watchOpponentGame: WebSocket is not available');
  }
  return { webSocket, jetstreamUrl: parsedJetstreamUrl.href };
}

/** Uses regex to extract the did and record key from an atproto URI (if it's a app.knightsky.game record.)
 * @param {unknown} uri
 * @param {string} name
 */
function parseGameUri(uri, name) {
  const match = typeof uri === 'string' ? AT_URI.exec(uri) : null;
  if (!match || match[2] !== GAME) {
    throw new TypeError(`watchOpponentGame: ${name} must be an AT-URI of an ${GAME} record`);
  }
  return { did: match[1], rkey: match[3] };
}

/** @param {Context} ctx */
function connect(ctx) {
  if (ctx.stopped) {
    return;
  }
  ctx.socketErrorReported = false;
  const url = new URL(ctx.jetstreamUrl);
  url.searchParams.append('dids', ctx.opponentDid);
  url.searchParams.append('collections', GAME);
  url.searchParams.append('collections', REJECT);
  url.searchParams.set('kinds', 'commit');
  if (ctx.cursor !== undefined) {
    url.searchParams.set('cursor', String(ctx.cursor));
  }

  try {
    const socket = new ctx.webSocket(url.href);
    ctx.socket = socket;
    attachSocketHandlers(ctx, socket);
  } catch (cause) {
    emit(
      ctx,
      ctx.onError,
      listenerError('NetworkError', `Could not connect to ${url.host}`, { cause }),
    );
    scheduleReconnect(ctx);
  }
}

/**
 * @param {Context} ctx
 * @param {WebSocket} socket
 */
function attachSocketHandlers(ctx, socket) {
  socket.onopen = () => onSocketOpen(ctx, socket);
  socket.onmessage = (event) => onSocketMessage(ctx, event);
  socket.onerror = (event) => onSocketError(ctx, socket, event);
  socket.onclose = () => onSocketClose(ctx);
}

/**
 * @param {Context} ctx
 * @param {WebSocket} socket
 */
function onSocketOpen(ctx, socket) {
  if (ctx.stopped) {
    return;
  }
  if (ctx.initialized) {
    ctx.failures = 0;
    ctx.ready = true;
    flushPendingEvents(ctx);
    return;
  }
  ctx.ready = false;
  void bootstrap(ctx, socket);
}

/**
 * @param {Context} ctx
 * @param {MessageEvent} event
 */
function onSocketMessage(ctx, event) {
  if (ctx.stopped) {
    return;
  }
  if (typeof event.data !== 'string') {
    emit(ctx, ctx.onError, listenerError('UnexpectedError', 'Jetstream sent a non-text event'));
    return;
  }
  let message;
  try {
    message = JSON.parse(event.data);
  } catch (cause) {
    emit(
      ctx,
      ctx.onError,
      listenerError('UnexpectedError', 'Jetstream sent invalid JSON', { cause }),
    );
    return;
  }
  const payload = message?.payload;
  const cursor = message?.cursor ?? payload?.cursor ?? payload?.seq;
  if (typeof cursor === 'number' && Number.isFinite(cursor)) {
    ctx.cursor = Math.max(ctx.cursor ?? 0, cursor);
  }
  if (payload?.$type !== 'network.bsky.jetstream.subscribeEvents#commit') {
    return;
  }
  if (!ctx.ready) {
    ctx.pendingEvents.push(payload);
  } else {
    enqueueEvent(ctx, payload);
  }
}

/**
 * @param {Context} ctx
 * @param {WebSocket} socket
 * @param {Event} event
 */
function onSocketError(ctx, socket, event) {
  if (ctx.stopped || ctx.socketErrorReported) {
    return;
  }
  ctx.socketErrorReported = true;
  emit(
    ctx,
    ctx.onError,
    listenerError('NetworkError', `Could not connect to ${new URL(ctx.jetstreamUrl).host}`, {
      cause: event,
    }),
  );
  socket.close();
}

/** @param {Context} ctx */
function onSocketClose(ctx) {
  if (ctx.stopped) {
    return;
  }
  ctx.ready = false;
  ctx.socket = null;
  if (!ctx.socketErrorReported) {
    emit(
      ctx,
      ctx.onError,
      listenerError(
        'NetworkError',
        `Jetstream connection to ${new URL(ctx.jetstreamUrl).host} closed`,
      ),
    );
  }
  scheduleReconnect(ctx);
}

/** Iterates over pendingEvents, removing them and enqueuing each one with enqueueEvent.
 * @param {Context} ctx
*/
function flushPendingEvents(ctx) {
  for (const message of ctx.pendingEvents.splice(0)) {
    enqueueEvent(ctx, message);
  }
}

/**
 * @param {Context} ctx
 * @param {WebSocket} socket
 */
async function bootstrap(ctx, socket) {
  const results = await Promise.allSettled([bootstrapGame(ctx), bootstrapRejections(ctx)]);
  if (ctx.stopped || ctx.socket !== socket) {
    return;
  }
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [asListenerError(result.reason)] : [],
  );
  errors.forEach((error) => emit(ctx, ctx.onError, error));
  if (errors.length) {
    ctx.socketErrorReported = true;
    socket.close();
    return;
  }
  ctx.failures = 0;
  ctx.initialized = true;
  ctx.ready = true;
  flushPendingEvents(ctx);
}

/** @param {Context} ctx */
async function bootstrapGame(ctx) {
  if (ctx.opponentUri) {
    try {
      handleGameVersion(ctx, await getRecord(ctx, ctx.opponentUri));
    } catch (caught) {
      const error = /** @type {ListenerError} */ (caught);
      if (error.code !== 'RecordNotFound') {
        throw error;
      }
      ctx.lastGameCid = null;
      ctx.missingReported = true;
      emit(ctx, ctx.onError, error);
    }
    return;
  }
  const acceptance = await findAcceptance(ctx);
  if (acceptance) {
    ctx.opponentUri = acceptance.uri;
    handleGameVersion(ctx, acceptance);
  }
}

/** @param {Context} ctx */
async function bootstrapRejections(ctx) {
  /** @type {FetchedRecord[]} */
  const unseen = [];
  for await (const version of listNewerThan(ctx, ctx.opponentDid, REJECT, ctx.myRkey)) {
    if (ctx.seenRejections.has(version.uri)) {
      break;
    }
    unseen.push(version);
  }
  let myCid;
  for (const version of unseen.reverse()) {
    await reportRejectionIfCurrent(ctx, version, () => {
      myCid ??= getRecord(ctx, ctx.myUri).then((record) => record.cid);
      return myCid;
    });
    ctx.seenRejections.add(version.uri);
  }
}

/** @param {Context} ctx */
function scheduleReconnect(ctx) {
  if (ctx.stopped || ctx.reconnectTimer !== undefined) {
    return;
  }
  ctx.failures += 1;
  const delay = Math.min(RECONNECT_DELAY_MS * 2 ** (ctx.failures - 1), MAX_BACKOFF_MS);
  ctx.reconnectTimer = setTimeout(() => {
    ctx.reconnectTimer = undefined;
    connect(ctx);
  }, delay);
}

/**
 * @param {Context} ctx
 * @param {any} message
 */
function enqueueEvent(ctx, message, attempt = 0) {
  ctx.processing = ctx.processing
    .then(() => processEvent(ctx, message))
    .catch((cause) => {
      emit(ctx, ctx.onError, asListenerError(cause));
      if (ctx.stopped) {
        return;
      }
      const delay = Math.min(RECONNECT_DELAY_MS * 2 ** attempt, MAX_BACKOFF_MS);
      /** @type {ReturnType<typeof setTimeout>} */
      let timer;
      timer = setTimeout(() => {
        ctx.eventRetryTimers.delete(timer);
        enqueueEvent(ctx, message, attempt + 1);
      }, delay);
      ctx.eventRetryTimers.add(timer);
    });
}

/**
 * @param {Context} ctx
 * @param {any} message
 */
async function processEvent(ctx, message) {
  if (ctx.stopped || message?.did !== ctx.opponentDid) {
    return;
  }
  const { operation, collection, rkey, record, cid } = message;
  if (![GAME, REJECT].includes(collection) || typeof rkey !== 'string') {
    return;
  }
  const uri = `at://${ctx.opponentDid}/${collection}/${rkey}`;
  if (!AT_URI.test(uri)) {
    return;
  }
  if (collection === GAME) {
    processGameEvent(ctx, { uri, rkey, operation, cid, record });
    return;
  }
  await processRejectionEvent(ctx, { uri, operation, cid, record });
}

/**
 * @param {Context} ctx
 * @param {{ uri: string, rkey: string, operation: string, cid: string, record: any }} event
 */
function processGameEvent(ctx, { uri, rkey, operation, cid, record }) {
  if (operation === 'delete') {
    if (ctx.opponentUri === uri) {
      ctx.lastGameCid = null;
      ctx.missingReported = true;
      emit(ctx, ctx.onError, listenerError('RecordNotFound', `${uri} does not exist`, { uri }));
    }
    return;
  }
  if (!['create', 'update'].includes(operation) || typeof cid !== 'string') {
    return;
  }
  const version = { uri, cid, value: record };
  if (ctx.opponentUri) {
    if (uri === ctx.opponentUri) {
      ctx.missingReported = false;
      handleGameVersion(ctx, version);
    }
    return;
  }
  if (
    rkey > ctx.myRkey &&
    record?.challenge?.uri === ctx.myUri &&
    record?.opponent === ctx.myDid &&
    isValid(ctx, GAME, version)
  ) {
    ctx.opponentUri = uri;
    handleGameVersion(ctx, version);
  }
}

/**
 * @param {Context} ctx
 * @param {{ uri: string, operation: string, cid: string, record: any }} event
 */
async function processRejectionEvent(ctx, { uri, operation, cid, record }) {
  if (!['create', 'update'].includes(operation) || typeof cid !== 'string') {
    return;
  }
  if (ctx.seenRejections.has(uri)) {
    return;
  }
  const version = { uri, cid, value: record };
  await reportRejectionIfCurrent(ctx, version, async () => (await getRecord(ctx, ctx.myUri)).cid);
  ctx.seenRejections.add(uri);
}

/**
 * @param {Context} ctx
 * @param {FetchedRecord} version
 * @param {() => Promise<string>} currentCid
 */
async function reportRejectionIfCurrent(ctx, version, currentCid) {
  const { uri, cid, value } = version;
  if (
    value?.subject?.uri !== ctx.myUri ||
    rkeyOf(uri) <= ctx.myRkey ||
    !isValid(ctx, REJECT, version)
  ) {
    return;
  }
  if (value.subject.cid === (await currentCid())) {
    emit(ctx, ctx.onRejection, { uri, cid, record: value, seenAt: Date.now() });
  }
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
 * @param {string} rkey
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
 * @param {string} uri
 * @returns {Promise<FetchedRecord>}
 */
async function getRecord(ctx, uri) {
  const [, did, collection, rkey] = /** @type {RegExpExecArray} */ (AT_URI.exec(uri));
  const body = await xrpc(ctx, did, 'com.atproto.repo.getRecord', { repo: did, collection, rkey });
  return { uri, cid: body.cid, value: body.value };
}

/**
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
 * @param {string} did
 * @param {string} method
 * @param {Record<string, string>} params
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

/** @param {Response} response */
function rateLimitReset(response) {
  const seconds = Number(response.headers.get('RateLimit-Reset'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/** @param {Context} ctx @param {string} did */
function pdsFor(ctx, did) {
  if (!ctx.pdsByDid.has(did)) {
    const lookup = resolvePds(ctx, did);
    lookup.catch(() => ctx.pdsByDid.delete(did));
    ctx.pdsByDid.set(did, lookup);
  }
  return /** @type {Promise<string>} */ (ctx.pdsByDid.get(did));
}

/**
 * @param {Context} ctx
 * @param {string} did
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
 * @param {unknown} error
 * @returns {ListenerError}
 */
function asListenerError(error) {
  if (error instanceof Error && typeof (/** @type {any} */ (error).code) === 'string') {
    return /** @type {ListenerError} */ (error);
  }
  return listenerError('UnexpectedError', 'Unexpected error while processing a Jetstream event', {
    cause: error,
  });
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
