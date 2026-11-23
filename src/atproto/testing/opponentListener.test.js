import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchOpponentGame } from '../opponentListener.js';

const GAME = 'app.knightsky.game';
const REJECT = 'app.knightsky.reject';
const ALICE = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
const BOB = 'did:plc:z72i7hdynmk6r22z27h6tvur';
const CAROL = 'did:plc:44ybard66vv44zksje25o7dz';
const ALICE_PDS = 'https://alice.pds.test';
const BOB_PDS = 'https://bob.pds.test';
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
// TIDs sort by creation time: the invitation comes first, acceptances after it.
const ALICE_RKEY = '3m2aaaaaaaa22';
const BOB_RKEY = '3m2bbbbbbbb22';
const ALICE_URI = `at://${ALICE}/${GAME}/${ALICE_RKEY}`;
const BOB_URI = `at://${BOB}/${GAME}/${BOB_RKEY}`;
// Characters TIDs are written in, in sort order.
const TID_CHARS = '234567abcdefghijklmnopqrstuvwxyz';
// The i-th of a run of TIDs starting with `prefix`, in creation order.
const tid = (prefix, i) =>
  `${prefix}${TID_CHARS[Math.floor(i / 32)]}${TID_CHARS[i % 32]}`.padEnd(12, 'a') + '2';
const CID = [
  'bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a',
  'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
  'bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgz7soqmoi',
  'bafyreihtx7h7nd5bpfy5vwnyhgbmwfqnbcbkuncxfwrlbgrkpnfn6pg2ie',
];

function game(overrides = {}) {
  return {
    $type: GAME,
    opponent: ALICE,
    color: 'black',
    challenge: { uri: ALICE_URI, cid: CID[0] },
    pgn: '',
    fen: START_FEN,
    status: 'active',
    ...overrides,
  };
}

function rejection(subjectCid, overrides = {}) {
  return {
    $type: REJECT,
    subject: { uri: ALICE_URI, cid: subjectCid },
    reason: 'illegalMove',
    ...overrides,
  };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * An in-memory stand-in for plc.directory and two PDSes. Records are kept per repo and
 * collection; listRecords returns them newest first, like a real PDS.
 */
function fakeNetwork() {
  const pds = { [ALICE]: ALICE_PDS, [BOB]: BOB_PDS };
  const repos = {};
  const requests = [];
  let failNext = null;

  const collection = (did, nsid) => ((repos[did] ??= {})[nsid] ??= new Map());

  // `uri` lets a test play a PDS that lies about where a record lives.
  function put(did, nsid, rkey, cid, value, uri = `at://${did}/${nsid}/${rkey}`) {
    collection(did, nsid).set(rkey, { uri, cid, value });
  }

  function remove(did, nsid, rkey) {
    collection(did, nsid).delete(rkey);
  }

  function respond(url) {
    if (url.origin === 'https://plc.directory') {
      const did = decodeURIComponent(url.pathname.slice(1));
      return pds[did]
        ? json({
            id: did,
            service: [
              { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds[did] },
            ],
          })
        : json({ message: 'DID not registered' }, 404);
    }
    const params = Object.fromEntries(url.searchParams);
    const did = Object.keys(pds).find((d) => pds[d] === url.origin);
    if (did !== params.repo) {
      return json({ error: 'RepoNotFound' }, 400);
    }
    const records = collection(params.repo, params.collection);
    if (url.pathname === '/xrpc/com.atproto.repo.getRecord') {
      const record = records.get(params.rkey);
      return record
        ? json(record)
        : json({ error: 'RecordNotFound', message: 'Could not locate record' }, 400);
    }
    const newestFirst = [...records.keys()].sort().reverse();
    const start = params.cursor ? newestFirst.indexOf(params.cursor) + 1 : 0;
    const page = newestFirst.slice(start, start + Number(params.limit));
    return json({
      records: page.map((rkey) => records.get(rkey)),
      ...(page.length ? { cursor: page.at(-1) } : {}),
    });
  }

  const fetch = vi.fn(async (href, { signal } = {}) => {
    const url = new URL(href);
    requests.push(url);
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (failNext) {
      const response = failNext(url);
      failNext = null;
      return response;
    }
    return respond(url);
  });

  return {
    fetch,
    put,
    remove,
    requests,
    failOnce: (fn) => (failNext = fn),
    calls: (method) => requests.filter((u) => u.pathname === `/xrpc/com.atproto.repo.${method}`),
  };
}

function callbacks() {
  return { onUpdate: vi.fn(), onRejection: vi.fn(), onError: vi.fn() };
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

function expectOnlyCall(mock, argument) {
  expect(mock).toHaveBeenCalledOnce();
  expect(mock).toHaveBeenCalledWith(argument);
}

let network;
let stop;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-22T12:00:00Z'));
  network = fakeNetwork();
  // Alice's own record always exists; rejections are compared against its current CID.
  network.put(ALICE, GAME, ALICE_RKEY, CID[0], game({ opponent: BOB, color: 'white' }));
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Alice watching Bob, whose record she already knows.
function watchBob(cb = callbacks()) {
  stop = watchOpponentGame({
    myRecordUri: ALICE_URI,
    opponentRecordUri: BOB_URI,
    fetch: network.fetch,
    ...cb,
  });
  return cb;
}

describe('watchOpponentGame options', () => {
  const valid = () => ({ myRecordUri: ALICE_URI, opponentRecordUri: BOB_URI, ...callbacks() });

  it.each(['onUpdate', 'onRejection', 'onError'])('requires %s', (name) => {
    expect(() => watchOpponentGame({ ...valid(), [name]: undefined })).toThrow(name);
  });

  it('requires exactly one of opponentRecordUri or opponentDid', () => {
    expect(() => watchOpponentGame({ ...valid(), opponentDid: BOB })).toThrow('exactly one');
    expect(() => watchOpponentGame({ ...valid(), opponentRecordUri: undefined })).toThrow(
      'exactly one',
    );
  });

  it.each([
    ['myRecordUri', undefined],
    ['myRecordUri', `at://${ALICE}/${REJECT}/${ALICE_RKEY}`],
    ['opponentRecordUri', 'https://example.com/game'],
  ])('rejects %s %j', (name, value) => {
    expect(() => watchOpponentGame({ ...valid(), [name]: value })).toThrow(name);
  });

  it('rejects an opponentDid that is not a DID', () => {
    expect(() =>
      watchOpponentGame({ ...valid(), opponentRecordUri: undefined, opponentDid: 'bob.test' }),
    ).toThrow('opponentDid');
  });
});

describe('watching a known opponent record', () => {
  it("reports the opponent's current record as the first update", async () => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    const cb = watchBob();
    await tick();

    expectOnlyCall(cb.onUpdate, {
      uri: BOB_URI,
      cid: CID[1],
      record: game(),
      seenAt: Date.now(),
    });
    expect(network.requests[0].href).toBe(`https://plc.directory/${BOB}`);
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('reports only versions with a new CID', async () => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    const cb = watchBob();
    await tick();
    await tick(1000);
    expect(cb.onUpdate).toHaveBeenCalledTimes(1);

    network.put(BOB, GAME, BOB_RKEY, CID[2], game({ pgn: '1. e4 *', fen: AFTER_E4 }));
    await tick(1000);
    expect(cb.onUpdate).toHaveBeenCalledTimes(2);
    expect(cb.onUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ cid: CID[2], record: game({ pgn: '1. e4 *', fen: AFTER_E4 }) }),
    );
  });

  it('polls once a second and looks up each PDS once', async () => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    watchBob();
    await tick();
    await tick(3000);

    expect(network.calls('getRecord')).toHaveLength(4);
    expect(network.requests.filter((u) => u.origin === 'https://plc.directory')).toHaveLength(1);
  });

  it('reports a deleted record once, keeps polling, and reports it again if it returns', async () => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    const cb = watchBob();
    await tick();
    network.remove(BOB, GAME, BOB_RKEY);
    await tick(1000);
    await tick(1000);

    expect(cb.onError).toHaveBeenCalledOnce();
    expect(cb.onError.mock.calls[0][0]).toMatchObject({ code: 'RecordNotFound', uri: BOB_URI });
    expect(network.calls('getRecord')).toHaveLength(3);

    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    await tick(1000);
    expect(cb.onUpdate).toHaveBeenCalledTimes(2);
  });

  it('reports a record that fails the lexicon once, then reports the next valid version', async () => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game({ status: 'resigned' }));
    const cb = watchBob();
    await tick();
    await tick(1000);

    expect(cb.onUpdate).not.toHaveBeenCalled();
    expect(cb.onError).toHaveBeenCalledOnce();
    expect(cb.onError.mock.calls[0][0]).toMatchObject({
      code: 'InvalidRecord',
      uri: BOB_URI,
      cid: CID[1],
    });

    network.put(BOB, GAME, BOB_RKEY, CID[2], game());
    await tick(1000);
    expectOnlyCall(cb.onUpdate, expect.objectContaining({ cid: CID[2] }));
  });
});

describe('finding the opponent acceptance', () => {
  function watchForBob(cb = callbacks()) {
    stop = watchOpponentGame({
      myRecordUri: ALICE_URI,
      opponentDid: BOB,
      fetch: network.fetch,
      ...cb,
    });
    return cb;
  }

  it('waits quietly until the opponent accepts, then reports the acceptance', async () => {
    const cb = watchForBob();
    await tick();
    await tick(1000);
    expect(cb.onUpdate).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();

    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    await tick(1000);
    expectOnlyCall(
      cb.onUpdate,
      expect.objectContaining({ uri: BOB_URI, cid: CID[1], record: game() }),
    );

    // From then on it watches that record directly instead of listing Bob's games.
    const gameListings = () =>
      network.calls('listRecords').filter((u) => u.searchParams.get('collection') === GAME);
    const listingsAtAcceptance = gameListings().length;
    network.put(BOB, GAME, BOB_RKEY, CID[2], game({ pgn: '1. e4 *', fen: AFTER_E4 }));
    await tick(1000);
    expect(cb.onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ cid: CID[2] }));
    expect(gameListings()).toHaveLength(listingsAtAcceptance);
  });

  it('ignores records for other challenges or naming another opponent', async () => {
    const otherChallenge = { uri: `at://${CAROL}/${GAME}/3m2cccccccc22`, cid: CID[0] };
    network.put(BOB, GAME, '3m2cccccccc22', CID[1], game({ challenge: otherChallenge }));
    network.put(BOB, GAME, '3m2dddddddd22', CID[2], game({ opponent: CAROL }));
    network.put(BOB, GAME, '3m2eeeeeeee22', CID[3], game({ challenge: undefined }));
    const cb = watchForBob();
    await tick();

    expect(cb.onUpdate).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('ignores a listed record whose URI is outside the opponent repo', async () => {
    // Bob's PDS claims Carol's record is in Bob's game collection.
    const carolUri = `at://${CAROL}/${GAME}/${BOB_RKEY}`;
    network.put(BOB, GAME, BOB_RKEY, CID[1], game(), carolUri);
    const cb = watchForBob();
    await tick();
    await tick(1000);

    expect(cb.onUpdate).not.toHaveBeenCalled();
    expect(network.calls('getRecord')).toHaveLength(0);
  });

  it('picks the oldest acceptance and sticks with it', async () => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    network.put(BOB, GAME, '3m2zzzzzzzz22', CID[2], game());
    const cb = watchForBob();
    await tick();
    network.put(BOB, GAME, '3m2zzzzzzzz22', CID[3], game({ pgn: '1. e4 *', fen: AFTER_E4 }));
    await tick(1000);

    expectOnlyCall(cb.onUpdate, expect.objectContaining({ uri: BOB_URI }));
  });

  it('stops paging at records older than the invitation', async () => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    for (let i = 0; i < 60; i++) {
      network.put(BOB, GAME, tid('3m1', i), CID[2], game());
    }
    const cb = watchForBob();
    await tick();

    // 61 records would need two pages; the first page already reaches the invitation.
    expect(
      network.calls('listRecords').filter((u) => u.searchParams.get('collection') === GAME),
    ).toHaveLength(1);
    expectOnlyCall(cb.onUpdate, expect.objectContaining({ uri: BOB_URI }));
  });
});

describe('rejections', () => {
  const REJECT_URI = (rkey) => `at://${BOB}/${REJECT}/${rkey}`;

  beforeEach(() => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
  });

  it('reports a rejection of the current version of my record', async () => {
    const cb = watchBob();
    await tick();
    network.put(BOB, REJECT, '3m2ffffffff22', CID[2], rejection(CID[0]));
    await tick(1000);

    expectOnlyCall(cb.onRejection, {
      uri: REJECT_URI('3m2ffffffff22'),
      cid: CID[2],
      record: rejection(CID[0]),
      seenAt: Date.now(),
    });
    await tick(1000);
    expect(cb.onRejection).toHaveBeenCalledOnce();
  });

  it('reports existing rejections on start, oldest first, and drops stale ones', async () => {
    network.put(BOB, REJECT, '3m2ffffffff22', CID[2], rejection(CID[3]));
    network.put(BOB, REJECT, '3m2gggggggg22', CID[2], rejection(CID[0], { reason: 'badFEN' }));
    network.put(BOB, REJECT, '3m2hhhhhhhh22', CID[2], rejection(CID[0], { reason: 'badClock' }));
    const cb = watchBob();
    await tick();

    expect(cb.onRejection.mock.calls.map(([r]) => r.record.reason)).toEqual(['badFEN', 'badClock']);
  });

  it('ignores rejections of other records', async () => {
    const elsewhere = { uri: `at://${CAROL}/${GAME}/3m2cccccccc22`, cid: CID[0] };
    network.put(BOB, REJECT, '3m2ffffffff22', CID[2], rejection(CID[0], { subject: elsewhere }));
    const cb = watchBob();
    await tick();

    expect(cb.onRejection).not.toHaveBeenCalled();
  });

  it('only fetches my own record when there is a new rejection to check', async () => {
    const myRecordFetches = () =>
      network.calls('getRecord').filter((u) => u.searchParams.get('repo') === ALICE);
    watchBob();
    await tick();
    await tick(1000);
    expect(myRecordFetches()).toHaveLength(0);

    network.put(BOB, REJECT, '3m2ffffffff22', CID[2], rejection(CID[0]));
    await tick(1000);
    expect(myRecordFetches()).toHaveLength(1);
  });

  it('checks a rejection again when my own record could not be fetched', async () => {
    network.put(BOB, REJECT, '3m2ffffffff22', CID[2], rejection(CID[0]));
    const cb = callbacks();
    let failMine = true;
    const realFetch = network.fetch.getMockImplementation();
    network.fetch.mockImplementation(async (href, init) => {
      const url = new URL(href);
      if (failMine && url.origin === ALICE_PDS) {
        failMine = false;
        network.requests.push(url);
        return json({ error: 'InternalServerError' }, 500);
      }
      return realFetch(href, init);
    });
    watchBob(cb);
    await tick();
    expect(cb.onRejection).not.toHaveBeenCalled();
    expect(cb.onError.mock.calls[0][0]).toMatchObject({ code: 'HttpError', status: 500 });

    await tick(2000);
    expect(cb.onRejection).toHaveBeenCalledOnce();
  });

  it('pages through rejections to reach the oldest new one', async () => {
    for (let i = 0; i < 55; i++) {
      network.put(BOB, REJECT, tid('3m2c', i), CID[2], rejection(i === 0 ? CID[0] : CID[3]));
    }
    const cb = watchBob();
    await tick();

    // 55 rejections span two pages (plus an empty one at the end of the cursor).
    expect(
      network.calls('listRecords').filter((u) => u.searchParams.get('collection') === REJECT)
        .length,
    ).toBeGreaterThan(1);
    expectOnlyCall(cb.onRejection, expect.objectContaining({ uri: REJECT_URI(tid('3m2c', 0)) }));
  });

  it('stops paging at rejections older than my record', async () => {
    for (let i = 0; i < 60; i++) {
      network.put(BOB, REJECT, tid('3m1', i), CID[2], rejection(CID[0]));
    }
    const cb = watchBob();
    await tick();

    expect(
      network.calls('listRecords').filter((u) => u.searchParams.get('collection') === REJECT),
    ).toHaveLength(1);
    expect(cb.onRejection).not.toHaveBeenCalled();
  });

  it('reports a rejection that fails the lexicon as an invalid record', async () => {
    network.put(BOB, REJECT, '3m2ffffffff22', CID[2], rejection(CID[0], { reason: '' }));
    const cb = watchBob();
    await tick();

    expect(cb.onRejection).not.toHaveBeenCalled();
    expect(cb.onError.mock.calls[0][0]).toMatchObject({
      code: 'InvalidRecord',
      uri: REJECT_URI('3m2ffffffff22'),
    });
  });
});

describe('errors and backoff', () => {
  beforeEach(() => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
  });

  it('reports a network failure and doubles the delay until a poll succeeds', async () => {
    const cb = watchBob();
    await tick();
    const offline = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const realFetch = network.fetch.getMockImplementation();
    network.fetch.mockImplementation(offline);

    await tick(1000); // fails: next poll in 2 s
    expect(cb.onError.mock.calls[0][0]).toMatchObject({ code: 'NetworkError' });
    expect(cb.onError.mock.calls[0][0].cause).toBeInstanceOf(TypeError);
    const failed = offline.mock.calls.length;

    await tick(1999);
    expect(offline.mock.calls.length).toBe(failed);
    await tick(1); // fails again: next poll in 4 s
    await tick(3999);
    expect(offline.mock.calls.length).toBe(failed * 2);

    network.fetch.mockImplementation(realFetch);
    await tick(1); // succeeds: back to 1 s
    const afterRecovery = network.fetch.mock.calls.length;
    await tick(1000);
    expect(network.fetch.mock.calls.length).toBeGreaterThan(afterRecovery);
  });

  it('caps the backoff at 30 seconds', async () => {
    const cb = watchBob();
    await tick();
    network.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await tick(120000);
    const errors = cb.onError.mock.calls.length;
    await tick(30000);

    // Two failures per poll (game record and rejections), one poll per 30 s.
    expect(cb.onError.mock.calls.length).toBe(errors + 2);
  });

  it('waits until RateLimit-Reset after a 429', async () => {
    const cb = watchBob();
    await tick();
    const resetAt = Date.now() / 1000 + 60;
    network.failOnce(() =>
      json({ error: 'RateLimitExceeded' }, 429, { 'RateLimit-Reset': `${resetAt}` }),
    );
    await tick(1000);
    expect(cb.onError.mock.calls[0][0]).toMatchObject({ code: 'RateLimited', status: 429 });

    const calls = network.fetch.mock.calls.length;
    // The 429 arrived 1 s in, so the reset is 59 s after it.
    await tick(58999);
    expect(network.fetch.mock.calls.length).toBe(calls);
    await tick(1);
    expect(network.fetch.mock.calls.length).toBeGreaterThan(calls);
  });

  it('caps the wait for a far-off RateLimit-Reset at 5 minutes', async () => {
    const cb = watchBob();
    await tick();
    const aYearAway = Date.now() / 1000 + 365 * 24 * 60 * 60;
    network.failOnce(() =>
      json({ error: 'RateLimitExceeded' }, 429, { 'RateLimit-Reset': `${aYearAway}` }),
    );
    await tick(1000);
    expect(cb.onError.mock.calls[0][0]).toMatchObject({ code: 'RateLimited' });

    const calls = network.fetch.mock.calls.length;
    await tick(5 * 60 * 1000 - 1);
    expect(network.fetch.mock.calls.length).toBe(calls);
    await tick(1);
    expect(network.fetch.mock.calls.length).toBeGreaterThan(calls);
  });

  it('backs off normally after a 429 without RateLimit-Reset', async () => {
    const cb = watchBob();
    await tick();
    network.failOnce(() => json({ error: 'RateLimitExceeded' }, 429));
    await tick(1000);
    expect(cb.onError.mock.calls[0][0]).toMatchObject({ code: 'RateLimited', resetAt: undefined });

    const calls = network.fetch.mock.calls.length;
    await tick(1999);
    expect(network.fetch.mock.calls.length).toBe(calls);
    await tick(1);
    expect(network.fetch.mock.calls.length).toBeGreaterThan(calls);
  });

  it('reports a malformed response as an UnexpectedError', async () => {
    const realFetch = network.fetch.getMockImplementation();
    network.fetch.mockImplementation(async (href, init) =>
      new URL(href).pathname.endsWith('listRecords') ? json(null) : realFetch(href, init),
    );
    const cb = watchBob();
    await tick();

    expect(cb.onError).toHaveBeenCalledOnce();
    const error = cb.onError.mock.calls[0][0];
    expect(error.code).toBe('UnexpectedError');
    expect(error.cause).toBeInstanceOf(TypeError);
    // The game record is still reported; only the rejections poll failed.
    expect(cb.onUpdate).toHaveBeenCalledOnce();
  });

  it('reports the requested URI even if the PDS answers with another', async () => {
    const realFetch = network.fetch.getMockImplementation();
    network.fetch.mockImplementation(async (href, init) => {
      const response = await realFetch(href, init);
      if (!new URL(href).pathname.endsWith('getRecord')) {
        return response;
      }
      const body = await response.json();
      return json({ ...body, uri: `at://${CAROL}/${GAME}/${BOB_RKEY}` });
    });
    const cb = watchBob();
    await tick();

    expectOnlyCall(cb.onUpdate, expect.objectContaining({ uri: BOB_URI }));
  });

  it('reports other HTTP errors with their status', async () => {
    const cb = watchBob();
    await tick();
    network.failOnce(() => json({ error: 'InternalServerError' }, 502));
    await tick(1000);

    expect(cb.onError.mock.calls[0][0]).toMatchObject({ code: 'HttpError', status: 502 });
  });

  it('reports a DID that cannot be resolved and retries the lookup', async () => {
    const cb = callbacks();
    stop = watchOpponentGame({
      myRecordUri: ALICE_URI,
      opponentRecordUri: `at://${CAROL}/${GAME}/${BOB_RKEY}`,
      fetch: network.fetch,
      ...cb,
    });
    await tick();
    expect(cb.onError.mock.calls[0][0]).toMatchObject({ code: 'PdsResolutionFailed', did: CAROL });

    await tick(2000);
    const lookups = network.requests.filter((u) => u.href === `https://plc.directory/${CAROL}`);
    expect(lookups.length).toBeGreaterThan(1);
  });

  it('resolves did:web through its well-known DID document', async () => {
    const webDid = 'did:web:bob.example.com';
    const fetch = vi.fn(async (href) => {
      if (href === 'https://bob.example.com/.well-known/did.json') {
        return json({ id: webDid, service: [{ id: '#atproto_pds', serviceEndpoint: BOB_PDS }] });
      }
      const url = new URL(href);
      return url.searchParams.get('collection') === GAME
        ? json({ uri: `at://${webDid}/${GAME}/${BOB_RKEY}`, cid: CID[1], value: game() })
        : json({ records: [] });
    });
    const cb = callbacks();
    stop = watchOpponentGame({
      myRecordUri: ALICE_URI,
      opponentRecordUri: `at://${webDid}/${GAME}/${BOB_RKEY}`,
      fetch,
      ...cb,
    });
    await tick();

    expect(cb.onError).not.toHaveBeenCalled();
    expect(cb.onUpdate).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[1][0]).toMatch(`${BOB_PDS}/xrpc/com.atproto.repo.getRecord?`);
  });
});

describe('stop', () => {
  it('stops polling and reports nothing afterwards, even from a request in flight', async () => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    const cb = watchBob();
    // Stop while the first poll is still waiting on the network.
    stop();
    await tick(5000);

    expect(cb.onUpdate).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
    expect(network.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('reports nothing from a response that arrives after stop, even if fetch ignores abort', async () => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    const realFetch = network.fetch.getMockImplementation();
    let release;
    const held = new Promise((resolve) => (release = resolve));
    // A fetch that ignores the abort signal and answers late.
    network.fetch.mockImplementation(async (href) => {
      await held;
      return realFetch(href);
    });
    const cb = watchBob();
    await tick();
    stop();
    release();
    await tick(5000);

    expect(cb.onUpdate).not.toHaveBeenCalled();
    expect(cb.onRejection).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('can be called more than once', async () => {
    watchBob();
    await tick();
    const calls = network.fetch.mock.calls.length;
    stop();
    stop();
    await tick(5000);

    expect(network.fetch.mock.calls.length).toBe(calls);
  });
});

it('keeps polling when a callback throws', async () => {
  network.put(BOB, GAME, BOB_RKEY, CID[1], game());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const cb = callbacks();
  cb.onUpdate.mockImplementation(() => {
    throw new Error('UI bug');
  });
  watchBob(cb);
  await tick();
  network.put(BOB, GAME, BOB_RKEY, CID[2], game({ pgn: '1. e4 *', fen: AFTER_E4 }));
  await tick(1000);

  expect(cb.onUpdate).toHaveBeenCalledTimes(2);
  expect(console.error).toHaveBeenCalledTimes(2);
});
