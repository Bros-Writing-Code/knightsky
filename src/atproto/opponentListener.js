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
 * - onError: something went wrong; see the codes above. The listener keeps running.
 * - fetch: defaults to the browser's fetch; tests can inject a stand-in.
 * - jetstreamUrl: optional Jetstream v2 `subscribeEvents` websocket endpoint.
 * - webSocket: defaults to the browser's WebSocket; tests can inject a stand-in.
 *
 * Throws a TypeError right away if the options are invalid.
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
 * Validates the options and builds the Context: the mutable state shared by every helper for
 * one watched game. Throws a TypeError for invalid options, so mistakes surface when the UI
 * calls watchOpponentGame() and not later as silent missing events.
 *
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
 * Picks the Jetstream endpoint and WebSocket constructor, using the defaults when they are not
 * given. Throws a TypeError if the URL is not ws:/wss: or no WebSocket is available.
 *
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

/**
 * Splits the AT-URI of an app.knightsky.game record into its DID and record key. Throws a
 * TypeError naming the option if `uri` is not a string, not an AT-URI, or in another collection.
 *
 * @param {unknown} uri
 * @param {string} name option name, used in the error message
 * @returns {{ did: string, rkey: string }}
 */
function parseGameUri(uri, name) {
  const match = typeof uri === 'string' ? AT_URI.exec(uri) : null;
  if (!match || match[2] !== GAME) {
    throw new TypeError(`watchOpponentGame: ${name} must be an AT-URI of an ${GAME} record`);
  }
  return { did: match[1], rkey: match[3] };
}

/**
 * Opens a Jetstream WebSocket filtered to commits on the opponent's game and reject collections.
 * On a reconnect it passes the last cursor so Jetstream replays the events missed meanwhile. If
 * the socket cannot even be created, it reports a NetworkError and schedules another try.
 *
 * @param {Context} ctx
 */
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
 * Connects the socket's open, message, error and close events to the listener's handlers.
 *
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
 * Runs when the socket connects. On the first connection it starts bootstrap(), which reads the
 * current state from the PDS and then processes the buffered events. On a reconnect the state is
 * already known, so it skips the PDS read and processes the buffered events right away.
 *
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
 * Runs for each Jetstream message. Reports non-text or non-JSON messages as UnexpectedError,
 * remembers the newest cursor for reconnects, and ignores anything that is not a commit. Commits
 * are queued for processing, or buffered in pendingEvents while the bootstrap is still running.
 *
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
 * Runs when the socket fails. Reports one NetworkError and closes the socket, which triggers
 * onSocketClose() and a reconnect. Setting socketErrorReported stops onSocketClose() from
 * reporting the same failure a second time.
 *
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

/**
 * Runs when the socket closes for any reason other than stop(). Marks the listener not ready, so
 * new events are buffered, reports a NetworkError unless one was already reported for this
 * socket, and schedules a reconnect.
 *
 * @param {Context} ctx
 */
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

/**
 * Moves every buffered event from pendingEvents into the processing queue, in arrival order.
 *
 * @param {Context} ctx
 */
function flushPendingEvents(ctx) {
  for (const message of ctx.pendingEvents.splice(0)) {
    enqueueEvent(ctx, message);
  }
}

/**
 * Reads the opponent's current game record and rejections from their PDS, in parallel, so the
 * UI gets the state as it was before the stream started. Stream events that arrive meanwhile are
 * buffered and processed afterwards, so nothing is lost.
 *
 * If any read fails, the errors are reported and the socket is closed, so the reconnect retries
 * the whole bootstrap. Results are dropped if stop() was called or a newer socket replaced this
 * one while the reads were in flight.
 *
 * @param {Context} ctx
 * @param {WebSocket} socket the socket this bootstrap belongs to
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

/**
 * Reports the opponent's current game record. If it is already known, it is fetched directly; a
 * missing record is reported as RecordNotFound without failing the bootstrap. Otherwise it
 * searches for the opponent's acceptance, and if there is none yet the live stream will find it.
 *
 * @param {Context} ctx
 */
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

/**
 * Reports rejections the opponent made before the listener started. It collects rejections newer
 * than my record (newest first, stopping at one already seen), then checks them oldest first.
 * My own record is fetched at most once, and only if a rejection needs checking.
 *
 * @param {Context} ctx
 */
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

/**
 * Calls connect() again after an exponential backoff: 1s, 2s, 4s, … up to 30s. The count resets
 * after a successful connection. Does nothing if a reconnect is already scheduled.
 *
 * @param {Context} ctx
 */
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
 * Adds a Jetstream commit to the processing queue. Events are processed one at a time, in order,
 * by chaining them onto ctx.processing, so an async rejection check cannot be overtaken by a
 * later event. If processing fails, the error is reported and the event is retried later with
 * exponential backoff.
 *
 * @param {Context} ctx
 * @param {any} message Jetstream commit payload
 * @param {number} [attempt] retries so far, used for the backoff delay
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
 * Handles one Jetstream commit. Ignores commits that are not from the opponent's repo or not in
 * the game or reject collections (Jetstream already filters, but its data is untrusted), then
 * passes the commit to the game or rejection handler.
 *
 * @param {Context} ctx
 * @param {any} message Jetstream commit payload
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
 * Handles a commit to the opponent's game collection:
 * - Deleting the watched record is reported as RecordNotFound.
 * - A new version of the watched record is passed to handleGameVersion().
 * - If the record is not known yet, a valid record that accepts my challenge, is newer than my
 *   record, and names me as the opponent becomes the watched record.
 * Other records in the collection, such as games with other players, are ignored.
 *
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
 * Handles a commit to the opponent's reject collection by checking whether it rejects the
 * current version of my record. Each rejection is checked once; it is marked as seen only after
 * the check succeeds, so a failed fetch of my record leads to a retry from enqueueEvent().
 *
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
 * Emits onRejection if the rejection targets my record, is newer than my record, matches the
 * reject lexicon, and names the CID of my record's current version. A rejection of an older
 * version is stale (I already changed my record), so it is dropped.
 *
 * @param {Context} ctx
 * @param {FetchedRecord} version the rejection record
 * @param {() => Promise<string>} currentCid returns my record's current CID; only called if the
 *   cheaper checks pass, so my record is not fetched needlessly
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
 * Emits onUpdate for a version of the opponent's game record, unless it has the same CID as the
 * last version (a duplicate, e.g. the bootstrap and the stream both delivered it) or fails the
 * game lexicon (reported once as InvalidRecord by isValid()).
 *
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
 * listRecords returns newest first, so the last match in the loop is the oldest.
 *
 * @param {Context} ctx
 * @returns {Promise<FetchedRecord | null>} null if the opponent has not accepted yet
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
 * Yields records in a collection whose record key is greater than `rkey`, newest first. Record
 * keys are TIDs, which sort by creation time, so it stops paging at the first record that is not
 * newer; anything older than my own record cannot belong to this game.
 *
 * @param {Context} ctx
 * @param {string} did
 * @param {string} collection
 * @param {string} rkey
 * @returns {AsyncGenerator<FetchedRecord>}
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
 * Checks a record against its collection's lexicon. An invalid record is reported as
 * InvalidRecord once per URI and CID, so repeated deliveries do not repeat the error.
 *
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
 * Fetches one record from the PDS of the repo that owns it.
 *
 * @param {Context} ctx
 * @param {string} uri AT-URI of the record; must already be validated
 * @returns {Promise<FetchedRecord>}
 */
async function getRecord(ctx, uri) {
  const [, did, collection, rkey] = /** @type {RegExpExecArray} */ (AT_URI.exec(uri));
  const body = await xrpc(ctx, did, 'com.atproto.repo.getRecord', { repo: did, collection, rkey });
  return { uri, cid: body.cid, value: body.value };
}

/**
 * Yields every record in a collection, newest first, fetching one page at a time so callers can
 * stop early. Records whose URI is outside the requested repo or collection are skipped, since
 * the PDS response is untrusted. Stops if the PDS repeats a cursor, so it cannot loop forever.
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
    const next = records.length && typeof body.cursor === 'string' ? body.cursor : undefined;
    cursor = next === cursor ? undefined : next;
  } while (cursor);
}

/**
 * Whether a listed record's URI is in the given repo and collection.
 *
 * @param {any} record
 * @param {string} did
 * @param {string} collection
 */
function isRecordIn(record, did, collection) {
  const match = typeof record?.uri === 'string' ? AT_URI.exec(record.uri) : null;
  return match !== null && match[1] === did && match[2] === collection;
}

/**
 * Returns the record key, the last path segment of an AT-URI.
 *
 * @param {string} uri
 */
function rkeyOf(uri) {
  return uri.slice(uri.lastIndexOf('/') + 1);
}

/**
 * Makes an XRPC read (GET) request to the PDS that hosts `did` and returns the JSON body. Error
 * responses are thrown as ListenerErrors: 429 → RateLimited (with resetAt), 400 RecordNotFound →
 * RecordNotFound (with the record's uri), anything else → HttpError.
 *
 * @param {Context} ctx
 * @param {string} did DID whose PDS receives the request
 * @param {string} method full XRPC method NSID, e.g. com.atproto.repo.listRecords
 * @param {Record<string, string>} params sent as URL search params
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
 * Sends a GET request with ctx.fetch, which stop() can abort. A request that never gets a
 * response (offline, DNS failure, aborted) is thrown as a NetworkError.
 *
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

/**
 * Reads the RateLimit-Reset header (seconds since the Unix epoch) and returns it in
 * milliseconds, or undefined if it is missing or invalid.
 *
 * @param {Response} response
 */
function rateLimitReset(response) {
  const seconds = Number(response.headers.get('RateLimit-Reset'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Returns the PDS URL for a DID, resolving it once and caching the result. The promise is
 * cached, not the URL, so concurrent callers share one lookup. A failed lookup is removed from
 * the cache so the next call tries again.
 *
 * @param {Context} ctx
 * @param {string} did
 * @returns {Promise<string>}
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
 * Finds a DID's PDS by fetching its DID document (from plc.directory for did:plc, or the
 * domain's /.well-known/did.json for did:web) and reading the #atproto_pds service endpoint.
 * Any failure is thrown as PdsResolutionFailed.
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

/**
 * Whether `text` parses as an absolute URL.
 *
 * @param {string} text
 */
function isUrl(text) {
  try {
    return Boolean(new URL(text));
  } catch {
    return false;
  }
}

/**
 * Passes ListenerErrors through unchanged and wraps anything else (a bug, a malformed response)
 * as an UnexpectedError with the original as its cause, so onError always gets a `code`.
 *
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
 * Creates an Error with a `code` and any extra fields (status, uri, …) that the UI can read.
 *
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
 * Calls one of the UI's callbacks. Does nothing after stop(), so late responses cannot reach
 * a screen that is gone, and logs an exception thrown by the callback so a UI bug cannot break
 * the listener.
 *
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
