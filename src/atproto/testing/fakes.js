// Test doubles for the network: a fake fetch that serves PLC documents and PDS repos, and a fake
// WebSocket that partysocket (inside @atcute/jetstream) can drive.
import { vi } from 'vitest';

export const GAME = 'app.knightsky.game';
export const REJECT = 'app.knightsky.reject';
export const ALICE = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
export const BOB = 'did:plc:z72i7hdynmk6r22z27h6tvur';
export const CAROL = 'did:plc:44ybard66vv44zksje25o7dz';
export const PDS = {
  [ALICE]: 'https://alice.pds.test',
  [BOB]: 'https://bob.pds.test',
  [CAROL]: 'https://carol.pds.test',
};
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
export const CID = [
  'bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a',
  'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
  'bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgz7soqmoi',
  'bafyreihtx7h7nd5bpfy5vwnyhgbmwfqnbcbkuncxfwrlbgrkpnfn6pg2ie',
  'bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
  'bafyreif5m3xbqdnqx3qhyxcokbaxkzpsyoyhd5kqgqc6vbgkpiaefqbb7u',
];

export const uri = (did, collection, rkey) => `at://${did}/${collection}/${rkey}`;

export function game(overrides = {}) {
  return {
    $type: GAME,
    opponent: BOB,
    color: 'white',
    pgn: '',
    fen: START_FEN,
    status: 'active',
    ...overrides,
  };
}

export function rejection(subjectUri, subjectCid, overrides = {}) {
  return {
    $type: REJECT,
    subject: { uri: subjectUri, cid: subjectCid },
    reason: 'illegalMove',
    ...overrides,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Answers one request from the PLC directory or from the repos in `collection`. */
function respond(url, collection) {
  if (url.origin === 'https://plc.directory') {
    const did = decodeURIComponent(url.pathname.slice(1));
    return PDS[did]
      ? json({
          id: did,
          service: [
            { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS[did] },
          ],
        })
      : json({ message: 'DID not registered' }, 404);
  }
  const params = Object.fromEntries(url.searchParams);
  const did = Object.keys(PDS).find((candidate) => PDS[candidate] === url.origin);
  if (did !== params.repo) {
    return json({ error: 'RepoNotFound' }, 400);
  }
  const records = collection(params.repo, params.collection);
  if (url.pathname === '/xrpc/com.atproto.repo.getRecord') {
    const record = records.get(params.rkey);
    return record ? json(record) : json({ error: 'RecordNotFound' }, 400);
  }
  const newestFirst = [...records.keys()].sort().reverse();
  const start = params.cursor ? newestFirst.indexOf(params.cursor) + 1 : 0;
  const page = newestFirst.slice(start, start + Number(params.limit));
  return json({
    records: page.map((rkey) => records.get(rkey)),
    ...(page.length ? { cursor: page.at(-1) } : {}),
  });
}

/** A fake fetch serving plc.directory DID documents and the repos of the DIDs in PDS. */
export function fakeNetwork() {
  const repos = {};
  const requests = [];
  let failNext;
  let failing;
  const collection = (did, nsid) => ((repos[did] ??= {})[nsid] ??= new Map());

  function put(did, nsid, rkey, cid, value) {
    collection(did, nsid).set(rkey, { uri: uri(did, nsid, rkey), cid, value });
  }

  const fetch = vi.fn(async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url);
    if (init.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (failing && failing.match(url)) {
      return failing.respond(url);
    }
    if (failNext && failNext.match(url)) {
      const { respond: fail } = failNext;
      failNext = undefined;
      return fail(url);
    }
    return respond(url, collection);
  });

  return {
    fetch,
    put,
    requests,
    /** Makes the next request matching `match` return or throw what `respond` does. */
    failOnce: (respond, match = () => true) => (failNext = { respond, match }),
    /** Makes every request matching `match` return or throw what `respond` does. */
    failAlways: (respond, match = () => true) => (failing = { respond, match }),
    calls: (method) =>
      requests.filter((url) => url.pathname === `/xrpc/com.atproto.repo.${method}`),
  };
}

/** A WebSocket stand-in. Tests open it and push Jetstream v2 frames into it. */
export class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url, protocols) {
    super();
    this.url = new URL(url);
    this.protocols = protocols;
    this.readyState = FakeWebSocket.CONNECTING;
    FakeWebSocket.instances.push(this);
  }

  get dids() {
    return this.url.searchParams.getAll('dids');
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  /** Pushes a Jetstream commit as an xrpc.v1.json message frame. */
  commit({ did, collection, rkey, cid, record, operation = 'update', seq }) {
    const payload = {
      $type: 'network.bsky.jetstream.subscribeEvents#commit',
      did,
      seq: seq ?? nextSeq++,
      time: new Date().toISOString(),
      collection,
      rkey,
      rev: '3m2zzzzzzzz22',
      operation,
      ...(operation === 'delete' ? {} : { cid, record }),
    };
    const frame = new MessageEvent('message', {
      data: JSON.stringify({ $type: 'message', payload }),
    });
    this.dispatchEvent(frame);
  }

  /** Simulates the connection dropping or failing to open. */
  fail() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event('error'));
  }

  send() {}

  close(code = 1000, reason = '') {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close', { code, reason }));
  }
}

let nextSeq = 1;

/** The most recent socket that is not closed. */
export function liveSocket() {
  return FakeWebSocket.instances.findLast((socket) => socket.readyState !== FakeWebSocket.CLOSED);
}
