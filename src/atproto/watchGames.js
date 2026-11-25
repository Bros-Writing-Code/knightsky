// @ts-check
/**
 * watchGames.js — keeps every ongoing game of the signed-in player up to date.
 *
 * One Jetstream subscription carries commits from the player's own repo and from every opponent's
 * repo. PDS reads fill in the state from before the subscription opened. The module only reports
 * records; it knows nothing about chess, so the UI validates moves with the engine.
 *
 * See docs/specs/multi-game-listener.md.
 */
import { subscribeEvents } from '@atcute/jetstream';
import { Lexicons } from '@atproto/lexicon';
import gameLexicon from './lexicons/app/knightsky/game.json';
import rejectLexicon from './lexicons/app/knightsky/reject.json';
import strongRefLexicon from './lexicons/com/atproto/repo/strongRef.json';
import { DID, GAME, REJECT, asCodedError, codedError, createPdsReader, parseAtUri } from './pds.js';

const JETSTREAM = 'wss://jetstream.us-west.bsky.network';
const RETRY_MS = 1000;
const MAX_BACKOFF_MS = 30000;
// After this many failed connections in a row, the saved cursor may be past Jetstream's retention,
// which looks exactly like a connection failure, so a fresh subscription replaces it.
const FAILURES_BEFORE_FRESH_START = 5;
// How long a replaced subscription keeps running after its successor opens. The new one starts at
// the live tip, so events the server already sent the old socket are still in flight; this covers
// them, and the overlap is deduplicated by CID.
const OVERLAP_MS = 5000;

// Records from other repos are untrusted, so every record is checked before it is reported.
// JSON imports are typed loosely (`lexicon: number`, not `1`), hence the cast.
const lexicons = new Lexicons(
  /** @type {import('@atproto/lexicon').LexiconDoc[]} */ (
    /** @type {unknown} */ ([strongRefLexicon, gameLexicon, rejectLexicon])
  ),
);

/**
 * @typedef {import('./pds.js').FetchedRecord} StoredRecord
 * @typedef {import('./pds.js').CodedError} WatchError
 * @typedef {{
 *   gameId: string,
 *   opponentDid: string,
 *   myRecord: StoredRecord,
 *   opponentRecord: StoredRecord | null,
 * }} GameSnapshot
 * @typedef {'added' | 'myRecordUpdated' | 'opponentUpdated' | 'rejected'} ChangeType
 * @typedef {{ type: ChangeType, game: GameSnapshot, rejection?: StoredRecord }} Change
 * @typedef {{
 *   myDid: string,
 *   onChange: (gameId: string, change: Change) => void,
 *   onError: (gameId: string | null, error: WatchError) => void,
 *   fetch?: typeof fetch,
 *   jetstreamUrl?: string,
 *   webSocket?: typeof WebSocket,
 * }} WatchOptions
 * @typedef {GameSnapshot & {
 *   myTouchedAt: number,
 *   opponentTouchedAt: number,
 *   seenRejections: Set<string>,
 *   pendingRejections: Map<string, StoredRecord[]>,
 *   syncing: boolean,
 *   resync: boolean,
 *   attempt: number,
 *   retryScheduled: boolean,
 * }} Game
 * @typedef {{ all: boolean, games: Set<string> }} SyncPlan
 * @typedef {{
 *   dids: Set<string>,
 *   controller: AbortController,
 *   plan: SyncPlan,
 *   opens: number,
 *   failures: number,
 *   sawEvent: boolean,
 * }} Stream
 * @typedef {ReturnType<typeof createContext>} Context
 */

/**
 * Starts watching every ongoing game of `myDid`: games whose record in the player's repo is not
 * `ended`. Games started later (in this tab through add(), or on another device) join on their
 * own.
 *
 * - onChange(gameId, { type, game, rejection? }) reports every change with the whole updated
 *   game: `added`, `myRecordUpdated`, `opponentUpdated`, or `rejected` (the opponent rejected the
 *   current version of my record).
 * - onError(gameId, error) reports a problem with one game, or with the stream when gameId is
 *   null. Codes: PdsResolutionFailed, NetworkError, RateLimited, HttpError, RecordNotFound,
 *   InvalidRecord, UnexpectedError. Watching continues.
 *
 * Throws a TypeError right away if the options are invalid.
 *
 * @param {WatchOptions} options
 */
export function watchGames(options) {
  const ctx = createContext(options);
  requestStream(ctx, { all: true, games: new Set() });
  return {
    /** Starts watching a game created in this tab, given the AT-URI of my game record. */
    add(/** @type {string} */ myRecordUri) {
      const parts = parseAtUri(myRecordUri);
      if (parts?.did !== ctx.myDid || parts.collection !== GAME) {
        throw new TypeError(`watchGames.add: expected an AT-URI of one of my ${GAME} records`);
      }
      void addGame(ctx, myRecordUri);
    },
    /** The latest known state of every game seen this session, including ended ones. */
    list: () => [...ctx.games.values()].map(snapshot),
    stop: () => stop(ctx),
  };
}

/** @param {WatchOptions} options */
function createContext(options) {
  const { myDid, onChange, onError } = options ?? {};
  for (const [name, callback] of Object.entries({ onChange, onError })) {
    if (typeof callback !== 'function') {
      throw new TypeError(`watchGames: ${name} must be a function`);
    }
  }
  if (typeof myDid !== 'string' || !DID.test(myDid)) {
    throw new TypeError('watchGames: myDid must be a DID');
  }
  const controller = new AbortController();
  return {
    myDid,
    onChange,
    onError,
    jetstreamUrl: options.jetstreamUrl ?? JETSTREAM,
    webSocket: options.webSocket,
    reader: createPdsReader({ fetch: options.fetch, signal: controller.signal }),
    controller,
    stopped: false,
    /** @type {Map<string, Game>} keyed by Game ID */
    games: new Map(),
    /** @type {Map<string, string>} my record URI → Game ID */
    gameIdByMyUri: new Map(),
    /** @type {Stream | null} the open subscription */
    stream: /** @type {Stream | null} */ (null),
    /** @type {Stream | null} a subscription with a newer DID list that has not opened yet */
    pending: /** @type {Stream | null} */ (null),
    /** @type {Set<Stream>} replaced subscriptions still running out their overlap */
    retiring: new Set(),
    /** @type {SyncPlan | null} work waiting for the next subscription, batched for a tick */
    requested: /** @type {SyncPlan | null} */ (null),
    /** Listings of my repo in progress; resubscribing waits for them, so pages batch together. */
    listing: 0,
    /** A NetworkError was reported and no subscription has opened since. */
    networkErrorReported: false,
    syncAllAttempt: 0,
    syncAllRetryScheduled: false,
    /** Counts stream events, so a PDS read can tell whether the stream got there first. */
    clock: 0,
    /** @type {Set<string>} uri + cid of records already reported as invalid */
    reportedInvalid: new Set(),
    /** @type {Set<ReturnType<typeof setTimeout>>} */
    timers: new Set(),
  };
}

/** @param {Context} ctx */
function stop(ctx) {
  ctx.stopped = true;
  ctx.controller.abort();
  ctx.stream?.controller.abort();
  ctx.pending?.controller.abort();
  ctx.retiring.forEach((stream) => stream.controller.abort());
  ctx.timers.forEach(clearTimeout);
  ctx.timers.clear();
}

// ---------------------------------------------------------------------------------------------
// The subscription
// ---------------------------------------------------------------------------------------------

/**
 * Asks for a subscription covering my DID and every opponent, and for `plan` to run once it is
 * open. Requests within one tick, or during a listing of my repo, are batched, so discovering
 * many games opens one subscription.
 *
 * @param {Context} ctx
 * @param {SyncPlan} plan
 */
function requestStream(ctx, plan) {
  if (ctx.requested) {
    ctx.requested = mergePlans(ctx.requested, plan);
    return;
  }
  ctx.requested = plan;
  later(ctx, 0, () => {
    if (ctx.listing === 0) {
      flushRequested(ctx);
    }
  });
}

/** @param {Context} ctx */
function flushRequested(ctx) {
  const requested = ctx.requested;
  if (requested) {
    ctx.requested = null;
    openStream(ctx, requested);
  }
}

/**
 * Starts a subscription for the current DID list. Jetstream v2 cannot change the filter of an
 * open socket, so the old subscription keeps running until the new one opens; the overlap is
 * deduplicated by CID, so nothing is missed in between. A newer request replaces a subscription
 * that has not opened yet and takes over its plan.
 *
 * @param {Context} ctx
 * @param {SyncPlan} plan
 */
function openStream(ctx, plan) {
  if (ctx.stopped) {
    return;
  }
  if (ctx.pending) {
    ctx.pending.controller.abort();
    plan = mergePlans(ctx.pending.plan, plan);
  }
  const opponents = [...ctx.games.values()].map((game) => game.opponentDid);
  /** @type {Stream} */
  const stream = {
    dids: new Set([ctx.myDid, ...opponents]),
    controller: new AbortController(),
    plan,
    opens: 0,
    failures: 0,
    sawEvent: false,
  };
  ctx.pending = stream;
  void runStream(ctx, stream);
}

/**
 * Iterates one subscription until it is aborted. @atcute/jetstream reconnects with backoff and
 * resumes from its cursor on its own; this handles what it cannot.
 *
 * @param {Context} ctx
 * @param {Stream} stream
 */
async function runStream(ctx, stream) {
  const events = subscribeEvents({
    service: ctx.jetstreamUrl,
    collections: [GAME, REJECT],
    kinds: ['commit'],
    dids: /** @type {any} */ ([...stream.dids]),
    signal: stream.controller.signal,
    ws: {
      WebSocket: ctx.webSocket,
      minReconnectionDelay: RETRY_MS,
      maxReconnectionDelay: MAX_BACKOFF_MS,
      reconnectionDelayGrowFactor: 2,
    },
    onConnectionOpen: () => onStreamOpen(ctx, stream),
    onConnectionClose: () => onStreamClose(ctx, stream),
    onError: (cause) =>
      report(ctx, null, codedError('UnexpectedError', 'Unreadable Jetstream event', { cause })),
  });
  try {
    for await (const event of events) {
      stream.sawEvent = true;
      if (!stream.controller.signal.aborted) {
        handleEvent(ctx, event);
      }
    }
  } catch (error) {
    if (!stream.controller.signal.aborted) {
      report(ctx, null, error);
    }
  }
}

/**
 * The first open of a new subscription replaces the old one, which keeps running for OVERLAP_MS,
 * and runs its plan. A reconnect that had no cursor to resume from (no event yet) may have missed
 * commits, so everything is re-read.
 *
 * @param {Context} ctx
 * @param {Stream} stream
 */
function onStreamOpen(ctx, stream) {
  if (ctx.stopped || stream.controller.signal.aborted) {
    return;
  }
  stream.opens += 1;
  stream.failures = 0;
  ctx.networkErrorReported = false;
  if (stream === ctx.pending) {
    if (ctx.stream) {
      retire(ctx, ctx.stream);
    }
    ctx.stream = stream;
    ctx.pending = null;
    runPlan(ctx, stream.plan);
  } else if (stream === ctx.stream && stream.opens > 1 && !stream.sawEvent) {
    runPlan(ctx, { all: true, games: new Set() });
  }
}

/**
 * Lets a replaced subscription run for OVERLAP_MS before closing it.
 *
 * @param {Context} ctx
 * @param {Stream} stream
 */
function retire(ctx, stream) {
  ctx.retiring.add(stream);
  later(ctx, OVERLAP_MS, () => {
    stream.controller.abort();
    ctx.retiring.delete(stream);
  });
}

/**
 * Reports the first failure of a streak as a NetworkError, once across all subscriptions. If the subscription had a cursor and
 * keeps failing, the cursor may have expired, so a fresh subscription from the live tip replaces
 * it and everything is re-read from the PDS.
 *
 * @param {Context} ctx
 * @param {Stream} stream
 */
function onStreamClose(ctx, stream) {
  if (ctx.stopped || stream.controller.signal.aborted) {
    return;
  }
  stream.failures += 1;
  if (!ctx.networkErrorReported) {
    ctx.networkErrorReported = true;
    report(ctx, null, codedError('NetworkError', 'Lost the connection to Jetstream'));
  }
  if (stream === ctx.stream && stream.sawEvent && stream.failures >= FAILURES_BEFORE_FRESH_START) {
    stream.sawEvent = false;
    openStream(ctx, { all: true, games: new Set() });
  }
}

/**
 * @param {SyncPlan} a
 * @param {SyncPlan} b
 * @returns {SyncPlan}
 */
function mergePlans(a, b) {
  return { all: a.all || b.all, games: new Set([...a.games, ...b.games]) };
}

/**
 * @param {Context} ctx
 * @param {SyncPlan} plan
 */
function runPlan(ctx, plan) {
  if (plan.all) {
    void syncAll(ctx);
    return;
  }
  for (const gameId of plan.games) {
    const game = ctx.games.get(gameId);
    if (game) {
      void syncOpponent(ctx, game);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Stream events
// ---------------------------------------------------------------------------------------------

/**
 * Routes one commit. Jetstream already filters by DID and collection, but its data is untrusted,
 * so both are checked again.
 *
 * @param {Context} ctx
 * @param {any} event
 */
function handleEvent(ctx, event) {
  if (ctx.stopped || event?.$type !== 'network.bsky.jetstream.subscribeEvents#commit') {
    return;
  }
  const { did, collection, rkey, operation, cid, record } = event;
  const uri = `at://${did}/${collection}/${rkey}`;
  if (![GAME, REJECT].includes(collection) || !parseAtUri(uri)) {
    return;
  }
  ctx.clock += 1;
  if (operation === 'delete') {
    handleDelete(ctx, did, uri);
    return;
  }
  if (!['create', 'update'].includes(operation) || typeof cid !== 'string') {
    return;
  }
  const version = { uri, cid, value: record };
  if (did === ctx.myDid) {
    if (collection === GAME) {
      handleMyRecord(ctx, version);
    }
    return;
  }
  if (collection === GAME) {
    for (const game of ctx.games.values()) {
      if (game.opponentDid === did) {
        handleOpponentEvent(ctx, game, version);
      }
    }
    return;
  }
  handleRejection(ctx, did, version);
}

/**
 * A deleted game record of mine or a watched opponent record is reported as RecordNotFound. The
 * game keeps its last known state.
 *
 * @param {Context} ctx
 * @param {string} did
 * @param {string} uri
 */
function handleDelete(ctx, did, uri) {
  for (const game of ctx.games.values()) {
    const mine = did === ctx.myDid && game.myRecord.uri === uri;
    if (mine || game.opponentRecord?.uri === uri) {
      report(ctx, game.gameId, codedError('RecordNotFound', `${uri} was deleted`, { uri }));
    }
  }
}

/**
 * Handles a new version of the watched opponent record, or, while I wait for an acceptance of my
 * invitation, a record that accepts it: newer than my record, pointing at it, and naming me.
 *
 * @param {Context} ctx
 * @param {Game} game
 * @param {StoredRecord} version
 */
function handleOpponentEvent(ctx, game, version) {
  // When I accepted, the opponent record is the invitation, known before any read finishes.
  const watched = game.opponentRecord?.uri ?? (isChallenger(game) ? null : game.gameId);
  if (watched) {
    if (version.uri === watched) {
      setOpponentRecord(ctx, game, version, ctx.clock);
    }
    return;
  }
  if (isAcceptance(ctx, game, version)) {
    setOpponentRecord(ctx, game, version, ctx.clock);
  }
}

/**
 * Reports a rejection of the current version of my record. A rejection naming a version the
 * stream has not delivered yet (I wrote it a moment ago) waits until that version arrives; one
 * naming an older version is stale, because I have already changed my record.
 *
 * @param {Context} ctx
 * @param {string} did
 * @param {StoredRecord} version
 */
function handleRejection(ctx, did, version) {
  const gameId = ctx.gameIdByMyUri.get(version.value?.subject?.uri);
  const game = gameId === undefined ? undefined : ctx.games.get(gameId);
  if (!game || game.opponentDid !== did || game.seenRejections.has(version.uri)) {
    return;
  }
  if (rkeyOf(version.uri) <= rkeyOf(game.myRecord.uri) || !isValid(ctx, game, REJECT, version)) {
    return;
  }
  game.seenRejections.add(version.uri);
  const subjectCid = version.value.subject.cid;
  if (subjectCid === game.myRecord.cid) {
    emitChange(ctx, game, 'rejected', { rejection: version });
  } else {
    const waiting = game.pendingRejections.get(subjectCid) ?? [];
    game.pendingRejections.set(subjectCid, [...waiting, version]);
  }
}

// ---------------------------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------------------------

/**
 * Applies a version of one of my game records, from the stream or (with `readAt`) from a PDS read
 * started when the event clock was at `readAt`. A read result is dropped if the stream delivered
 * that record since the read started; the stream is at least as new and brings anything newer.
 *
 * An unknown record that is not `ended` is a new game: from add(), from another device, or found
 * at startup. If its opponent is new, the subscription is replaced to include them.
 *
 * @param {Context} ctx
 * @param {StoredRecord} version
 * @param {number} [readAt]
 */
function handleMyRecord(ctx, version, readAt) {
  const gameId = ctx.gameIdByMyUri.get(version.uri);
  const known = gameId === undefined ? undefined : ctx.games.get(gameId);
  if (known) {
    if (
      (readAt !== undefined && known.myTouchedAt > readAt) ||
      version.cid === known.myRecord.cid
    ) {
      return;
    }
    if (isValid(ctx, known, GAME, version)) {
      setMyRecord(ctx, known, version, readAt);
    }
    return;
  }
  if (!isValid(ctx, null, GAME, version)) {
    return;
  }
  const { status, opponent, challenge } = version.value;
  const newGameId = challenge?.uri ?? version.uri;
  if (status === 'ended' || opponent === ctx.myDid || ctx.games.has(newGameId)) {
    return;
  }
  addNewGame(ctx, newGameId, opponent, version, readAt);
}

/**
 * @param {Context} ctx
 * @param {string} gameId
 * @param {string} opponentDid
 * @param {StoredRecord} myRecord
 * @param {number} [readAt]
 */
function addNewGame(ctx, gameId, opponentDid, myRecord, readAt) {
  /** @type {Game} */
  const game = {
    gameId,
    opponentDid,
    myRecord,
    opponentRecord: null,
    myTouchedAt: readAt === undefined ? ctx.clock : 0,
    opponentTouchedAt: 0,
    seenRejections: new Set(),
    pendingRejections: new Map(),
    syncing: false,
    resync: false,
    attempt: 0,
    retryScheduled: false,
  };
  ctx.games.set(gameId, game);
  ctx.gameIdByMyUri.set(myRecord.uri, gameId);
  emitChange(ctx, game, 'added');
  const covered = ctx.pending ?? ctx.stream;
  if (covered?.dids.has(opponentDid) && !ctx.requested) {
    if (covered === ctx.stream) {
      void syncOpponent(ctx, game);
    } else {
      covered.plan.games.add(gameId);
    }
    return;
  }
  requestStream(ctx, { all: false, games: new Set([gameId]) });
}

/**
 * @param {Context} ctx
 * @param {Game} game
 * @param {StoredRecord} version
 * @param {number} [readAt]
 */
function setMyRecord(ctx, game, version, readAt) {
  game.myRecord = version;
  if (readAt === undefined) {
    game.myTouchedAt = ctx.clock;
  }
  emitChange(ctx, game, 'myRecordUpdated');
  const waiting = game.pendingRejections.get(version.cid);
  game.pendingRejections.delete(version.cid);
  for (const rejection of waiting ?? []) {
    emitChange(ctx, game, 'rejected', { rejection });
  }
}

/**
 * @param {Context} ctx
 * @param {Game} game
 * @param {StoredRecord} version
 * @param {number} touchedAt the event clock for stream versions, 0 for PDS reads
 */
function setOpponentRecord(ctx, game, version, touchedAt) {
  if (version.cid === game.opponentRecord?.cid || !isValid(ctx, game, GAME, version)) {
    return;
  }
  game.opponentRecord = version;
  game.opponentTouchedAt = Math.max(game.opponentTouchedAt, touchedAt);
  emitChange(ctx, game, 'opponentUpdated');
}

/**
 * @param {Context} ctx
 * @param {string} myRecordUri
 */
async function addGame(ctx, myRecordUri) {
  const readAt = ctx.clock;
  try {
    handleMyRecord(ctx, await ctx.reader.getRecord(myRecordUri), readAt);
  } catch (error) {
    if (!ctx.stopped) {
      report(ctx, null, error);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// PDS reads
// ---------------------------------------------------------------------------------------------

/**
 * Reads all of my game records, then the opponent side of every game whose opponent the current
 * subscription covers; games with new opponents are read once the new subscription opens. Runs
 * at startup and whenever commits may have been missed. A failure is retried with backoff, with
 * at most one retry waiting however many syncs fail.
 *
 * @param {Context} ctx
 */
async function syncAll(ctx) {
  const readAt = ctx.clock;
  ctx.listing += 1;
  try {
    for await (const version of ctx.reader.listRecords(ctx.myDid, GAME)) {
      handleMyRecord(ctx, version, readAt);
    }
    ctx.syncAllAttempt = 0;
  } catch (error) {
    if (!ctx.stopped) {
      report(ctx, null, error);
      scheduleSyncAllRetry(ctx);
    }
    return;
  } finally {
    ctx.listing -= 1;
    if (ctx.listing === 0) {
      flushRequested(ctx);
    }
  }
  for (const game of ctx.games.values()) {
    if (ctx.stream?.dids.has(game.opponentDid)) {
      void syncOpponent(ctx, game);
    }
  }
}

/** @param {Context} ctx */
function scheduleSyncAllRetry(ctx) {
  if (ctx.syncAllRetryScheduled) {
    return;
  }
  ctx.syncAllRetryScheduled = true;
  later(ctx, backoff(ctx.syncAllAttempt++), () => {
    ctx.syncAllRetryScheduled = false;
    void syncAll(ctx);
  });
}

/**
 * Reads the opponent's record (or looks for the acceptance of my invitation) and the rejections
 * they made, for state from before the subscription covered them. A request made while a read
 * is running runs again afterwards. Failures are reported and retried with backoff (one retry
 * waiting per game), except a missing challenger record, which retrying cannot fix.
 *
 * @param {Context} ctx
 * @param {Game} game
 */
async function syncOpponent(ctx, game) {
  if (game.syncing) {
    game.resync = true;
    return;
  }
  game.syncing = true;
  const readAt = ctx.clock;
  try {
    const version = await readOpponentRecord(ctx, game);
    if (version && game.opponentTouchedAt <= readAt) {
      setOpponentRecord(ctx, game, version, 0);
    }
    await readRejections(ctx, game);
    game.attempt = 0;
  } catch (error) {
    if (ctx.stopped) {
      return;
    }
    const coded = asCodedError(error);
    report(ctx, game.gameId, coded);
    if (coded.code !== 'RecordNotFound' && !game.retryScheduled) {
      game.retryScheduled = true;
      later(ctx, backoff(game.attempt++), () => {
        game.retryScheduled = false;
        void syncOpponent(ctx, game);
      });
    }
  } finally {
    game.syncing = false;
  }
  if (game.resync && !ctx.stopped) {
    game.resync = false;
    void syncOpponent(ctx, game);
  }
}

/**
 * The challenger's record when I accepted; otherwise the acceptance of my invitation, if any.
 *
 * @param {Context} ctx
 * @param {Game} game
 * @returns {Promise<StoredRecord | null>}
 */
async function readOpponentRecord(ctx, game) {
  if (!isChallenger(game)) {
    return ctx.reader.getRecord(game.gameId);
  }
  if (game.opponentRecord) {
    return ctx.reader.getRecord(game.opponentRecord.uri);
  }
  return findAcceptance(ctx, game);
}

/**
 * The opponent's oldest valid record that accepts my invitation, or null. Record keys are TIDs,
 * which sort by creation time, so the listing stops at the first record older than mine.
 *
 * @param {Context} ctx
 * @param {Game} game
 */
async function findAcceptance(ctx, game) {
  /** @type {StoredRecord | null} */
  let oldest = null;
  for await (const version of listNewerThanMine(ctx, game, GAME)) {
    if (isAcceptance(ctx, game, version)) {
      oldest = version;
    }
  }
  return oldest;
}

/**
 * Feeds the opponent's rejections from before the subscription through handleRejection(),
 * oldest first.
 *
 * @param {Context} ctx
 * @param {Game} game
 */
async function readRejections(ctx, game) {
  /** @type {StoredRecord[]} */
  const found = [];
  for await (const version of listNewerThanMine(ctx, game, REJECT)) {
    found.push(version);
  }
  for (const version of found.reverse()) {
    handleRejection(ctx, game.opponentDid, version);
  }
}

/**
 * @param {Context} ctx
 * @param {Game} game
 * @param {string} collection
 * @returns {AsyncGenerator<StoredRecord>}
 */
async function* listNewerThanMine(ctx, game, collection) {
  const myRkey = rkeyOf(game.myRecord.uri);
  for await (const version of ctx.reader.listRecords(game.opponentDid, collection)) {
    if (rkeyOf(version.uri) <= myRkey) {
      return;
    }
    yield version;
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** @param {Game} game */
function isChallenger(game) {
  return game.gameId === game.myRecord.uri;
}

/**
 * @param {Context} ctx
 * @param {Game} game
 * @param {StoredRecord} version
 */
function isAcceptance(ctx, game, version) {
  return (
    rkeyOf(version.uri) > rkeyOf(game.myRecord.uri) &&
    version.value?.challenge?.uri === game.myRecord.uri &&
    version.value?.opponent === ctx.myDid &&
    isValid(ctx, game, GAME, version)
  );
}

/**
 * Checks a record against its lexicon, reporting each invalid version once as InvalidRecord.
 *
 * @param {Context} ctx
 * @param {Game | null} game
 * @param {string} collection
 * @param {StoredRecord} version
 */
function isValid(ctx, game, collection, { uri, cid, value }) {
  try {
    lexicons.assertValidRecord(collection, value);
    return true;
  } catch (cause) {
    const key = `${uri} ${cid}`;
    if (!ctx.reportedInvalid.has(key)) {
      ctx.reportedInvalid.add(key);
      const message = `${uri} does not match the ${collection} lexicon`;
      report(ctx, game?.gameId ?? null, codedError('InvalidRecord', message, { cause, uri, cid }));
    }
    return false;
  }
}

/** @param {Game} game @returns {GameSnapshot} */
function snapshot({ gameId, opponentDid, myRecord, opponentRecord }) {
  return { gameId, opponentDid, myRecord, opponentRecord };
}

/** @param {string} uri */
function rkeyOf(uri) {
  return uri.slice(uri.lastIndexOf('/') + 1);
}

/** @param {number} attempt */
function backoff(attempt) {
  return Math.min(RETRY_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

/**
 * Runs `fn` after `ms` unless stop() is called first.
 *
 * @param {Context} ctx
 * @param {number} ms
 * @param {() => void} fn
 */
function later(ctx, ms, fn) {
  const timer = setTimeout(() => {
    ctx.timers.delete(timer);
    if (!ctx.stopped) {
      fn();
    }
  }, ms);
  ctx.timers.add(timer);
}

/**
 * Calls the UI's onChange, isolating the module from exceptions in UI code.
 *
 * @param {Context} ctx
 * @param {Game} game
 * @param {ChangeType} type
 * @param {{ rejection?: StoredRecord }} [extra]
 */
function emitChange(ctx, game, type, extra = {}) {
  if (ctx.stopped) {
    return;
  }
  try {
    ctx.onChange(game.gameId, { type, game: snapshot(game), ...extra });
  } catch (error) {
    console.error(error);
  }
}

/**
 * @param {Context} ctx
 * @param {string | null} gameId
 * @param {unknown} error
 */
function report(ctx, gameId, error) {
  if (ctx.stopped) {
    return;
  }
  try {
    ctx.onError(gameId, asCodedError(error));
  } catch (callbackError) {
    console.error(callbackError);
  }
}
