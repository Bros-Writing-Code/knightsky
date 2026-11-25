import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchGames } from '../watchGames.js';
import {
  AFTER_E4,
  ALICE,
  BOB,
  CAROL,
  CID,
  FakeWebSocket,
  GAME,
  PDS,
  REJECT,
  fakeNetwork,
  game,
  liveSocket,
  rejection,
  uri,
} from './fakes.js';

// Alice is the signed-in player. She invited Bob (he accepted) and accepted Carol's invitation.
const ALICE_INVITE = uri(ALICE, GAME, '3m2aaaaaaaa22');
const BOB_ACCEPT = uri(BOB, GAME, '3m2bbbbbbbb22');
const CAROL_INVITE = uri(CAROL, GAME, '3m2bbbbbbbc22');
const ALICE_ACCEPT = uri(ALICE, GAME, '3m2cccccccc22');
const rkey = (atUri) => atUri.split('/').at(-1);

let network;
let watcher;
let onChange;
let onError;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  network = fakeNetwork();
  onChange = vi.fn();
  onError = vi.fn();
  network.put(ALICE, GAME, rkey(ALICE_INVITE), CID[0], game({ opponent: BOB, color: 'white' }));
  network.put(
    BOB,
    GAME,
    rkey(BOB_ACCEPT),
    CID[1],
    game({ opponent: ALICE, color: 'black', challenge: { uri: ALICE_INVITE, cid: CID[0] } }),
  );
});

afterEach(() => {
  watcher?.stop();
  watcher = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Lets pending timers and promise chains run. Fake setTimeout(fn, 0) waits 1 ms, as in Node. */
async function flush() {
  for (let i = 0; i < 20; i += 1) {
    await vi.advanceTimersByTimeAsync(1);
  }
}

/** Opens every socket that is still connecting, as Jetstream would. */
async function openSockets() {
  await flush();
  let socket;
  while (
    (socket = FakeWebSocket.instances.find((s) => s.readyState === FakeWebSocket.CONNECTING))
  ) {
    socket.open();
    await flush();
  }
}

/** Waits for the client's next reconnect attempt and lets it succeed. */
async function reconnect() {
  const connecting = () =>
    FakeWebSocket.instances.some((socket) => socket.readyState === FakeWebSocket.CONNECTING);
  // Step in 1 s increments so the socket is opened before partysocket's 4 s connect timeout.
  for (let i = 0; i < 60 && !connecting(); i += 1) {
    await vi.advanceTimersByTimeAsync(1000);
  }
  await openSockets();
}

async function start(options = {}) {
  watcher = watchGames({
    myDid: ALICE,
    onChange,
    onError,
    fetch: network.fetch,
    jetstreamUrl: 'wss://jetstream.test',
    webSocket: FakeWebSocket,
    ...options,
  });
  await openSockets();
  return watcher;
}

const bobMoved = () =>
  game({
    opponent: ALICE,
    color: 'black',
    challenge: { uri: ALICE_INVITE, cid: CID[0] },
    fen: AFTER_E4,
  });

const changes = (type) => onChange.mock.calls.filter(([, change]) => change.type === type);

function addCarolGame() {
  network.put(CAROL, GAME, rkey(CAROL_INVITE), CID[2], game({ opponent: ALICE, color: 'white' }));
  network.put(
    ALICE,
    GAME,
    rkey(ALICE_ACCEPT),
    CID[3],
    game({ opponent: CAROL, color: 'black', challenge: { uri: CAROL_INVITE, cid: CID[2] } }),
  );
}

describe('options', () => {
  const valid = () => ({ myDid: ALICE, onChange, onError, webSocket: FakeWebSocket });

  it.each(['onChange', 'onError'])('requires %s to be a function', (name) => {
    expect(() => watchGames({ ...valid(), [name]: undefined })).toThrow(name);
  });

  it('requires myDid to be a DID', () => {
    expect(() => watchGames({ ...valid(), myDid: 'alice.test' })).toThrow('myDid');
  });

  it('add() requires one of my game record URIs', async () => {
    await start();
    expect(() => watcher.add(BOB_ACCEPT)).toThrow(TypeError);
  });
});

describe('startup', () => {
  it('finds ongoing games, skipping ended ones, and reads the opponent side', async () => {
    addCarolGame();
    network.put(ALICE, GAME, '3m29aaaaaaa22', CID[4], game({ status: 'ended' }));
    await start();

    expect(
      changes('added')
        .map(([gameId]) => gameId)
        .sort(),
    ).toEqual([ALICE_INVITE, CAROL_INVITE].sort());
    const games = Object.fromEntries(watcher.list().map((g) => [g.gameId, g]));
    expect(games[ALICE_INVITE]).toMatchObject({
      opponentDid: BOB,
      myRecord: { uri: ALICE_INVITE, cid: CID[0] },
      opponentRecord: { uri: BOB_ACCEPT, cid: CID[1] },
    });
    expect(games[CAROL_INVITE]).toMatchObject({
      opponentDid: CAROL,
      myRecord: { uri: ALICE_ACCEPT },
      opponentRecord: { uri: CAROL_INVITE, cid: CID[2] },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('subscribes to my DID, then to one stream covering every opponent', async () => {
    addCarolGame();
    await start();
    const [first, second, ...rest] = FakeWebSocket.instances;
    expect(rest).toEqual([]);
    expect(first.dids).toEqual([ALICE]);
    expect(new Set(second.dids)).toEqual(new Set([ALICE, BOB, CAROL]));
    expect(second.url.searchParams.getAll('collections')).toEqual([GAME, REJECT]);
    expect(second.url.searchParams.get('kinds')).toBe('commit');
    expect(second.protocols).toBe('xrpc.v1.json');
    // The old stream closes only after the new one has opened, plus a grace period.
    expect(first.readyState).toBe(FakeWebSocket.OPEN);
    await vi.advanceTimersByTimeAsync(5000);
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(liveSocket()).toBe(second);
  });

  it('waits for an acceptance when nobody has accepted my invitation yet', async () => {
    network.put(ALICE, GAME, '3m2ddddddddd2', CID[4], game({ opponent: CAROL }));
    await start();
    const waiting = watcher.list().find((g) => g.opponentDid === CAROL);
    expect(waiting.opponentRecord).toBeNull();
  });
});

describe('live updates', () => {
  it('reports a new version of the opponent record once', async () => {
    await start();
    onChange.mockClear();
    const moved = game({
      opponent: ALICE,
      color: 'black',
      challenge: { uri: ALICE_INVITE, cid: CID[0] },
      fen: AFTER_E4,
    });
    const commit = {
      did: BOB,
      collection: GAME,
      rkey: rkey(BOB_ACCEPT),
      cid: CID[5],
      record: moved,
    };
    liveSocket().commit(commit);
    liveSocket().commit(commit);
    await flush();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(ALICE_INVITE, {
      type: 'opponentUpdated',
      game: expect.objectContaining({
        opponentRecord: { uri: BOB_ACCEPT, cid: CID[5], value: moved },
      }),
    });
  });

  it('finds an acceptance of my invitation on the stream', async () => {
    network.put(ALICE, GAME, '3m2ddddddddd2', CID[4], game({ opponent: CAROL }));
    await start();
    const myUri = uri(ALICE, GAME, '3m2ddddddddd2');
    const accept = game({
      opponent: ALICE,
      color: 'black',
      challenge: { uri: myUri, cid: CID[4] },
    });
    liveSocket().commit({
      did: CAROL,
      collection: GAME,
      rkey: '3m2eeeeeeee22',
      cid: CID[5],
      record: accept,
      operation: 'create',
    });
    await flush();

    expect(watcher.list().find((g) => g.gameId === myUri).opponentRecord).toMatchObject({
      uri: uri(CAROL, GAME, '3m2eeeeeeee22'),
    });
  });

  it('ignores records from the opponent that belong to other games', async () => {
    await start();
    onChange.mockClear();
    liveSocket().commit({
      did: BOB,
      collection: GAME,
      rkey: '3m2zzzzzzzz22',
      cid: CID[5],
      record: game({ opponent: CAROL }),
    });
    await flush();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports an invalid opponent record once, with its game', async () => {
    await start();
    const commit = {
      did: BOB,
      collection: GAME,
      rkey: rkey(BOB_ACCEPT),
      cid: CID[5],
      record: { $type: GAME, pgn: 1 },
    };
    liveSocket().commit(commit);
    liveSocket().commit({ ...commit, seq: undefined });
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      ALICE_INVITE,
      expect.objectContaining({ code: 'InvalidRecord' }),
    );
  });

  it('reports a deleted opponent record as RecordNotFound', async () => {
    await start();
    liveSocket().commit({
      did: BOB,
      collection: GAME,
      rkey: rkey(BOB_ACCEPT),
      operation: 'delete',
    });
    await flush();
    expect(onError).toHaveBeenCalledWith(
      ALICE_INVITE,
      expect.objectContaining({ code: 'RecordNotFound' }),
    );
  });
});

describe('adding games', () => {
  it('add() with a new opponent replaces the subscription and reads the game', async () => {
    await start();
    addCarolGame();
    watcher.add(ALICE_ACCEPT);
    await openSockets();

    expect(new Set(liveSocket().dids)).toEqual(new Set([ALICE, BOB, CAROL]));
    expect(watcher.list().find((g) => g.gameId === CAROL_INVITE).opponentRecord).toMatchObject({
      cid: CID[2],
    });
  });

  it('add() with a known opponent keeps the subscription', async () => {
    await start();
    const sockets = FakeWebSocket.instances.length;
    network.put(ALICE, GAME, '3m2ddddddddd2', CID[4], game({ opponent: BOB }));
    watcher.add(uri(ALICE, GAME, '3m2ddddddddd2'));
    await openSockets();

    expect(FakeWebSocket.instances).toHaveLength(sockets);
    expect(changes('added').map(([gameId]) => gameId)).toContain(uri(ALICE, GAME, '3m2ddddddddd2'));
  });

  it('picks up a game I started on another device', async () => {
    await start();
    addCarolGame();
    liveSocket().commit({
      did: ALICE,
      collection: GAME,
      rkey: rkey(ALICE_ACCEPT),
      cid: CID[3],
      record: game({
        opponent: CAROL,
        color: 'black',
        challenge: { uri: CAROL_INVITE, cid: CID[2] },
      }),
      operation: 'create',
    });
    await openSockets();

    expect(new Set(liveSocket().dids)).toEqual(new Set([ALICE, BOB, CAROL]));
    expect(watcher.list().find((g) => g.gameId === CAROL_INVITE).opponentRecord).not.toBeNull();
  });

  it('reports my own record changing on another device', async () => {
    await start();
    const moved = game({ opponent: BOB, fen: AFTER_E4 });
    liveSocket().commit({
      did: ALICE,
      collection: GAME,
      rkey: rkey(ALICE_INVITE),
      cid: CID[5],
      record: moved,
    });
    await flush();
    expect(changes('myRecordUpdated')).toEqual([
      [
        ALICE_INVITE,
        {
          type: 'myRecordUpdated',
          game: expect.objectContaining({
            myRecord: { uri: ALICE_INVITE, cid: CID[5], value: moved },
          }),
        },
      ],
    ]);
  });

  it('keeps an ended game in the list', async () => {
    await start();
    liveSocket().commit({
      did: ALICE,
      collection: GAME,
      rkey: rkey(ALICE_INVITE),
      cid: CID[5],
      record: game({ status: 'ended' }),
    });
    await flush();
    expect(watcher.list().find((g) => g.gameId === ALICE_INVITE).myRecord.value.status).toBe(
      'ended',
    );
  });
});

describe('swapping subscriptions', () => {
  it('keeps handling events from the old subscription during the grace period', async () => {
    await start();
    const old = liveSocket();
    addCarolGame();
    watcher.add(ALICE_ACCEPT);
    await openSockets();
    expect(liveSocket()).not.toBe(old);
    onChange.mockClear();

    // A move the server sent the old socket just before the swap.
    old.commit({
      did: BOB,
      collection: GAME,
      rkey: rkey(BOB_ACCEPT),
      cid: CID[5],
      record: bobMoved(),
    });
    await flush();
    expect(changes('opponentUpdated')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(old.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('opens one subscription for a discovery that spans several pages', async () => {
    // 50 newer games against Bob fill the first page; the game against Carol is on the second.
    for (let i = 0; i < 50; i += 1) {
      network.put(
        ALICE,
        GAME,
        `3m4${String(i).padStart(10, 'a')}`,
        CID[4],
        game({ opponent: BOB }),
      );
    }
    network.put(ALICE, GAME, '3m21aaaaaaa22', CID[4], game({ opponent: CAROL }));
    const original = network.fetch.getMockImplementation();
    network.fetch.mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.searchParams.get('repo') === ALICE && url.searchParams.has('cursor')) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return original(input, init);
    });
    await start();
    // Both delayed pages and the empty one that ends the listing.
    await vi.advanceTimersByTimeAsync(100);
    await openSockets();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(new Set(liveSocket().dids)).toEqual(new Set([ALICE, BOB, CAROL]));
  });

  it('reports one NetworkError when both the old and the new subscription fail', async () => {
    await start();
    const current = liveSocket();
    addCarolGame();
    watcher.add(ALICE_ACCEPT);
    await flush();
    const pending = FakeWebSocket.instances.at(-1);
    expect(pending.readyState).toBe(FakeWebSocket.CONNECTING);

    current.fail();
    pending.fail();
    await flush();
    const networkErrors = onError.mock.calls.filter(([, error]) => error.code === 'NetworkError');
    expect(networkErrors).toHaveLength(1);
  });
});

describe('rejections', () => {
  const rejectCommit = (subjectCid, rk = '3m2ffffffff22') => ({
    did: BOB,
    collection: REJECT,
    rkey: rk,
    cid: CID[4],
    record: rejection(ALICE_INVITE, subjectCid),
    operation: 'create',
  });

  it('reports a rejection of the current version of my record', async () => {
    await start();
    liveSocket().commit(rejectCommit(CID[0]));
    await flush();
    expect(changes('rejected')).toEqual([
      [
        ALICE_INVITE,
        expect.objectContaining({
          rejection: expect.objectContaining({ uri: uri(BOB, REJECT, '3m2ffffffff22') }),
        }),
      ],
    ]);
  });

  it('drops a rejection of an older version', async () => {
    await start();
    liveSocket().commit({
      did: ALICE,
      collection: GAME,
      rkey: rkey(ALICE_INVITE),
      cid: CID[5],
      record: game(),
    });
    liveSocket().commit(rejectCommit(CID[0]));
    await flush();
    expect(changes('rejected')).toEqual([]);
  });

  it('holds a rejection of a version the stream has not delivered yet', async () => {
    await start();
    liveSocket().commit(rejectCommit(CID[5]));
    await flush();
    expect(changes('rejected')).toEqual([]);
    liveSocket().commit({
      did: ALICE,
      collection: GAME,
      rkey: rkey(ALICE_INVITE),
      cid: CID[5],
      record: game(),
    });
    await flush();
    expect(onChange.mock.calls.slice(-2).map(([, change]) => change.type)).toEqual([
      'myRecordUpdated',
      'rejected',
    ]);
  });

  it('reports rejections made before startup', async () => {
    network.put(BOB, REJECT, '3m2ffffffff22', CID[4], rejection(ALICE_INVITE, CID[0]));
    await start();
    expect(changes('rejected')).toHaveLength(1);
  });
});

describe('reads racing the stream', () => {
  it('keeps a stream version that arrives while the PDS read is running', async () => {
    let release;
    const original = network.fetch.getMockImplementation();
    network.fetch.mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const isBobGames =
        url.searchParams.get('repo') === BOB && url.searchParams.get('collection') === GAME;
      if (!release && isBobGames) {
        // Hold only the first page, so the read completes once released.
        await new Promise((resolve) => (release = resolve));
      }
      return original(input, init);
    });
    await start();
    const moved = game({
      opponent: ALICE,
      color: 'black',
      challenge: { uri: ALICE_INVITE, cid: CID[0] },
      fen: AFTER_E4,
    });
    liveSocket().commit({
      did: BOB,
      collection: GAME,
      rkey: rkey(BOB_ACCEPT),
      cid: CID[5],
      record: moved,
    });
    await flush();
    release();
    await flush();
    expect(watcher.list()[0].opponentRecord.cid).toBe(CID[5]);
  });
});

describe('failures', () => {
  it('reports a lost connection once per streak', async () => {
    await start();
    liveSocket().fail();
    await vi.advanceTimersByTimeAsync(1000);
    FakeWebSocket.instances.at(-1).fail();
    await flush();
    const networkErrors = onError.mock.calls.filter(([, error]) => error.code === 'NetworkError');
    expect(networkErrors).toEqual([[null, expect.any(Error)]]);
  });

  it('starts a fresh subscription and re-reads everything when the cursor may have expired', async () => {
    await start();
    liveSocket().commit({
      did: BOB,
      collection: GAME,
      rkey: '3m2zzzzzzzz22',
      cid: CID[5],
      record: game({ opponent: CAROL }),
    });
    await flush();
    const reads = network.calls('listRecords').length;
    for (let i = 0; i < 5; i += 1) {
      FakeWebSocket.instances.at(-1).fail();
      await vi.advanceTimersByTimeAsync(30000);
    }
    const fresh = FakeWebSocket.instances.find(
      (s) => !s.url.searchParams.has('cursor') && s.readyState === FakeWebSocket.CONNECTING,
    );
    expect(fresh).toBeDefined();
    fresh.open();
    await flush();
    expect(network.calls('listRecords').length).toBeGreaterThan(reads);
  });

  it('retries a failed opponent read with backoff', async () => {
    network.failOnce(
      () => new Response('{}', { status: 500 }),
      (url) => url.searchParams.get('repo') === BOB,
    );
    await start();
    expect(onError).toHaveBeenCalledWith(
      ALICE_INVITE,
      expect.objectContaining({ code: 'HttpError' }),
    );
    expect(watcher.list()[0].opponentRecord).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(watcher.list()[0].opponentRecord).toMatchObject({ cid: CID[1] });
  });

  it('keeps one retry chain per game however many syncs fail', async () => {
    network.failAlways(
      () => new Response('{}', { status: 500 }),
      (url) => url.origin === PDS[BOB],
    );
    await start();
    // Each reconnect without a cursor re-reads every game, and each read fails again.
    for (let i = 0; i < 3; i += 1) {
      liveSocket().fail();
      await reconnect();
    }
    // Let the backoff reach its 30 s cap, then count attempts over two minutes.
    await vi.advanceTimersByTimeAsync(300000);
    const before = network.requests.length;
    await vi.advanceTimersByTimeAsync(120000);
    const bobAttempts = network.requests.slice(before).filter((url) => url.origin === PDS[BOB]);
    expect(bobAttempts.length).toBeLessThanOrEqual(5);
  });

  it('stop() closes the socket and silences callbacks', async () => {
    await start();
    const socket = liveSocket();
    watcher.stop();
    await flush();
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    onChange.mockClear();
    socket.commit({
      did: BOB,
      collection: GAME,
      rkey: rkey(BOB_ACCEPT),
      cid: CID[5],
      record: game(),
    });
    await flush();
    expect(onChange).not.toHaveBeenCalled();
  });
});
