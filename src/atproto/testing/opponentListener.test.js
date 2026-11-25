import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchOpponentGame } from '../opponentListener.js';

const GAME = 'app.knightsky.game';
const REJECT = 'app.knightsky.reject';
const ALICE = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
const BOB = 'did:plc:z72i7hdynmk6r22z27h6tvur';
const CAROL = 'did:plc:44ybard66vv44zksje25o7dz';
const ALICE_PDS = 'https://alice.pds.test';
const BOB_PDS = 'https://bob.pds.test';
const JETSTREAM = 'wss://jetstream.test/xrpc/network.bsky.jetstream.subscribeEvents';
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const ALICE_RKEY = '3m2aaaaaaaa22';
const BOB_RKEY = '3m2bbbbbbbb22';
const ALICE_URI = `at://${ALICE}/${GAME}/${ALICE_RKEY}`;
const BOB_URI = `at://${BOB}/${GAME}/${BOB_RKEY}`;
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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.onopen?.({});
  }

  send(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  close() {
    this.closed = true;
    this.onclose?.({});
  }
}

function fakeNetwork() {
  const pds = { [ALICE]: ALICE_PDS, [BOB]: BOB_PDS };
  const repos = {};
  const requests = [];
  let failNext;
  const collection = (did, nsid) => ((repos[did] ??= {})[nsid] ??= new Map());

  function put(did, nsid, rkey, cid, value, uri = `at://${did}/${nsid}/${rkey}`) {
    collection(did, nsid).set(rkey, { uri, cid, value });
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
    const did = Object.keys(pds).find((candidate) => pds[candidate] === url.origin);
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
      const fail = failNext;
      failNext = undefined;
      return fail(url);
    }
    return respond(url);
  });

  return {
    fetch,
    put,
    requests,
    failOnce: (fn) => (failNext = fn),
    calls: (method) =>
      requests.filter((url) => url.pathname === `/xrpc/com.atproto.repo.${method}`),
  };
}

function callbacks() {
  return { onUpdate: vi.fn(), onRejection: vi.fn(), onError: vi.fn() };
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

function commit(repo, collection, rkey, cid, record, operation = 'update') {
  const seq = Date.now() * 1000;
  return {
    $type: 'message',
    cursor: seq,
    payload: {
      $type: 'network.bsky.jetstream.subscribeEvents#commit',
      did: repo,
      seq,
      operation,
      collection,
      rkey,
      cid,
      record,
    },
  };
}

let network;
let stop;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-22T12:00:00Z'));
  FakeWebSocket.instances = [];
  network = fakeNetwork();
  network.put(ALICE, GAME, ALICE_RKEY, CID[0], game({ opponent: BOB, color: 'white' }));
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function start(options = {}) {
  const cb = options.callbacks ?? callbacks();
  stop = watchOpponentGame({
    myRecordUri: ALICE_URI,
    opponentRecordUri: BOB_URI,
    fetch: network.fetch,
    jetstreamUrl: JETSTREAM,
    webSocket: FakeWebSocket,
    ...cb,
    ...options,
  });
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  return { cb, socket };
}

describe('watchOpponentGame options', () => {
  const valid = () => ({
    myRecordUri: ALICE_URI,
    opponentRecordUri: BOB_URI,
    ...callbacks(),
    webSocket: FakeWebSocket,
  });

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

  it('rejects an invalid opponent DID and a non-WebSocket endpoint', () => {
    expect(() =>
      watchOpponentGame({
        ...valid(),
        opponentRecordUri: undefined,
        opponentDid: 'bob.test',
      }),
    ).toThrow('opponentDid');
    expect(() => watchOpponentGame({ ...valid(), jetstreamUrl: 'https://example.com' })).toThrow(
      'ws:',
    );
  });
});

describe('Jetstream updates', () => {
  it('subscribes to the opponent collections and bootstraps the known record', async () => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    const { cb, socket } = start();
    await tick();

    const url = new URL(socket.url);
    expect(url.searchParams.getAll('dids')).toEqual([BOB]);
    expect(url.searchParams.getAll('collections')).toEqual([GAME, REJECT]);
    expect(url.searchParams.get('kinds')).toBe('commit');
    expect(cb.onUpdate).toHaveBeenCalledWith({
      uri: BOB_URI,
      cid: CID[1],
      record: game(),
      seenAt: Date.now(),
    });
    expect(network.calls('getRecord')).toHaveLength(1);
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('delivers live game updates once and ignores unrelated repositories and records', async () => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    const { cb, socket } = start();
    await tick();
    cb.onUpdate.mockClear();

    socket.send(commit(BOB, GAME, BOB_RKEY, CID[2], game({ pgn: '1. e4 *', fen: AFTER_E4 })));
    socket.send(commit(BOB, GAME, BOB_RKEY, CID[2], game({ pgn: '1. e4 *', fen: AFTER_E4 })));
    socket.send(commit(CAROL, GAME, BOB_RKEY, CID[3], game()));
    await tick();

    expect(cb.onUpdate).toHaveBeenCalledOnce();
    expect(cb.onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: BOB_URI,
        cid: CID[2],
        record: game({ pgn: '1. e4 *', fen: AFTER_E4 }),
      }),
    );
  });

  it('buffers stream commits until the initial PDS read completes', async () => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    let releaseFetch;
    const fetchesReady = new Promise((resolve) => (releaseFetch = resolve));
    const heldFetch = vi.fn(async (href, init) => {
      await fetchesReady;
      return network.fetch.getMockImplementation()(href, init);
    });
    const cb = callbacks();
    stop = watchOpponentGame({
      myRecordUri: ALICE_URI,
      opponentRecordUri: BOB_URI,
      fetch: heldFetch,
      jetstreamUrl: JETSTREAM,
      webSocket: FakeWebSocket,
      ...cb,
    });
    const socket = FakeWebSocket.instances.at(-1);
    socket.open();
    socket.send(commit(BOB, GAME, BOB_RKEY, CID[2], game({ pgn: '1. e4 *', fen: AFTER_E4 })));
    releaseFetch();
    await tick();

    expect(cb.onUpdate.mock.calls.map(([update]) => update.cid)).toEqual([CID[1], CID[2]]);
  });

  it('discovers and reports the oldest matching acceptance on startup', async () => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    network.put(BOB, GAME, '3m2zzzzzzzz22', CID[2], game());
    const cb = callbacks();
    stop = watchOpponentGame({
      myRecordUri: ALICE_URI,
      opponentDid: BOB,
      fetch: network.fetch,
      jetstreamUrl: JETSTREAM,
      webSocket: FakeWebSocket,
      ...cb,
    });
    FakeWebSocket.instances.at(-1).open();
    await tick();

    expect(cb.onUpdate).toHaveBeenCalledOnce();
    expect(cb.onUpdate.mock.calls[0][0]).toMatchObject({ uri: BOB_URI, cid: CID[1] });
  });

  it('discovers an acceptance from the live stream when none existed at startup', async () => {
    const cb = callbacks();
    stop = watchOpponentGame({
      myRecordUri: ALICE_URI,
      opponentDid: BOB,
      fetch: network.fetch,
      jetstreamUrl: JETSTREAM,
      webSocket: FakeWebSocket,
      ...cb,
    });
    const socket = FakeWebSocket.instances.at(-1);
    socket.open();
    await tick();

    socket.send(commit(BOB, GAME, BOB_RKEY, CID[1], game(), 'create'));
    await tick();
    expect(cb.onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ uri: BOB_URI, cid: CID[1], record: game() }),
    );
  });

  it('reports a rejection of the current own-record version from the stream', async () => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    const { cb, socket } = start();
    await tick();
    socket.send(commit(BOB, REJECT, '3m2ffffffff22', CID[2], rejection(CID[0]), 'create'));
    await tick();

    expect(cb.onRejection).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: `at://${BOB}/${REJECT}/3m2ffffffff22`,
        cid: CID[2],
        record: rejection(CID[0]),
      }),
    );
    expect(network.calls('getRecord')).toHaveLength(2);
  });

  it('retries a rejection event when fetching my current record fails', async () => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    const realFetch = network.fetch.getMockImplementation();
    let failMyRecord = true;
    network.fetch.mockImplementation(async (href, init) => {
      const url = new URL(href);
      if (failMyRecord && url.origin === ALICE_PDS) {
        failMyRecord = false;
        network.requests.push(url);
        return json({ error: 'InternalServerError' }, 500);
      }
      return realFetch(href, init);
    });
    const { cb, socket } = start();
    await tick();
    socket.send(commit(BOB, REJECT, '3m2ffffffff22', CID[2], rejection(CID[0]), 'create'));
    await tick();

    expect(cb.onRejection).not.toHaveBeenCalled();
    expect(cb.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'HttpError' }));
    await tick(1000);
    expect(cb.onRejection).toHaveBeenCalledOnce();
  });

  it('bootstraps existing rejections oldest first and drops stale or invalid ones', async () => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    network.put(BOB, REJECT, '3m2ffffffff22', CID[2], rejection(CID[3]));
    network.put(BOB, REJECT, '3m2gggggggg22', CID[2], rejection(CID[0], { reason: 'badFEN' }));
    network.put(BOB, REJECT, '3m2hhhhhhhh22', CID[2], rejection(CID[0], { reason: '' }));
    const { cb } = start();
    await tick();

    expect(cb.onRejection.mock.calls.map(([value]) => value.record.reason)).toEqual(['badFEN']);
    expect(cb.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'InvalidRecord' }));
  });

  it('reports deletions and ignores later updates to a different record', async () => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    const { cb, socket } = start();
    await tick();
    socket.send(commit(BOB, GAME, BOB_RKEY, undefined, undefined, 'delete'));
    socket.send(commit(BOB, GAME, '3m2cccccccc22', CID[2], game(), 'create'));
    await tick();

    expect(cb.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'RecordNotFound' }));
    expect(cb.onUpdate).toHaveBeenCalledOnce();
  });
});

describe('connection lifecycle', () => {
  it('reconnects with the last Jetstream cursor and backs off after a close', async () => {
    const { cb, socket } = start();
    await tick();
    socket.send({
      $type: 'message',
      cursor: 123456,
      payload: { $type: 'network.bsky.jetstream.subscribeEvents#identity' },
    });
    socket.close();
    expect(cb.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'NetworkError' }));
    await tick(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await tick(1);

    const next = FakeWebSocket.instances.at(-1);
    expect(new URL(next.url).searchParams.get('cursor')).toBe('123456');
    next.open();
    next.send(commit(BOB, GAME, BOB_RKEY, CID[1], game()));
    await tick();
    expect(cb.onUpdate).toHaveBeenCalledOnce();
  });

  it('retries a failed startup bootstrap and stops the socket and reconnect timer', async () => {
    network.put(BOB, GAME, BOB_RKEY, CID[1], game());
    network.failOnce(() => {
      throw new TypeError('offline');
    });
    const { cb, socket } = start();
    await tick();
    expect(cb.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PdsResolutionFailed' }),
    );
    expect(socket.closed).toBe(true);
    await tick(1000);
    const retry = FakeWebSocket.instances.at(-1);
    retry.open();
    await tick();
    expect(cb.onUpdate).toHaveBeenCalledOnce();

    stop();
    expect(retry.closed).toBe(true);
    const count = FakeWebSocket.instances.length;
    await tick(60000);
    expect(FakeWebSocket.instances).toHaveLength(count);
  });

  it('reports no events after stop, including a bootstrap response already in flight', async () => {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const fetch = vi.fn(async (href, init) => {
      await held;
      return network.fetch.getMockImplementation()(href, init);
    });
    const cb = callbacks();
    stop = watchOpponentGame({
      myRecordUri: ALICE_URI,
      opponentRecordUri: BOB_URI,
      fetch,
      jetstreamUrl: JETSTREAM,
      webSocket: FakeWebSocket,
      ...cb,
    });
    const socket = FakeWebSocket.instances.at(-1);
    socket.open();
    stop();
    release();
    await tick();
    socket.send(commit(BOB, GAME, BOB_RKEY, CID[1], game()));

    expect(socket.closed).toBe(true);
    expect(cb.onUpdate).not.toHaveBeenCalled();
    expect(cb.onRejection).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
  });
});
