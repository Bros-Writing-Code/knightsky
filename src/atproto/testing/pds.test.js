import { describe, expect, it } from 'vitest';
import { codedError, asCodedError, createPdsReader, parseAtUri } from '../pds.js';
import { ALICE, BOB, CID, GAME, fakeNetwork, game, uri } from './fakes.js';

const GAME_URI = uri(ALICE, GAME, '3m2aaaaaaaa22');

function setup() {
  const network = fakeNetwork();
  network.put(ALICE, GAME, '3m2aaaaaaaa22', CID[0], game());
  const reader = createPdsReader({ fetch: network.fetch });
  return { network, reader };
}

async function collect(iterator) {
  const items = [];
  for await (const item of iterator) {
    items.push(item);
  }
  return items;
}

describe('getRecord', () => {
  it('resolves the PDS through plc.directory and reads the record', async () => {
    const { reader } = setup();
    await expect(reader.getRecord(GAME_URI)).resolves.toEqual({
      uri: GAME_URI,
      cid: CID[0],
      value: game(),
    });
  });

  it('looks up each DID once', async () => {
    const { network, reader } = setup();
    await reader.getRecord(GAME_URI);
    await reader.getRecord(GAME_URI);
    expect(network.requests.filter((url) => url.origin === 'https://plc.directory')).toHaveLength(
      1,
    );
  });

  it('reports a missing record as RecordNotFound with its uri', async () => {
    const { reader } = setup();
    const missing = uri(ALICE, GAME, '3m2zzzzzzzz22');
    await expect(reader.getRecord(missing)).rejects.toMatchObject({
      code: 'RecordNotFound',
      uri: missing,
    });
  });

  it('reports an unknown DID as PdsResolutionFailed and retries the lookup later', async () => {
    const { network, reader } = setup();
    const unknown = uri('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', GAME, '3m2aaaaaaaa22');
    await expect(reader.getRecord(unknown)).rejects.toMatchObject({ code: 'PdsResolutionFailed' });
    await expect(reader.getRecord(unknown)).rejects.toMatchObject({ code: 'PdsResolutionFailed' });
    expect(network.requests.filter((url) => url.origin === 'https://plc.directory')).toHaveLength(
      2,
    );
  });

  it.each([
    [
      () => new Response('{}', { status: 429, headers: { 'RateLimit-Reset': '1800000000' } }),
      {
        code: 'RateLimited',
        resetAt: 1800000000000,
      },
    ],
    [() => new Response('{}', { status: 500 }), { code: 'HttpError', status: 500 }],
    [() => Promise.reject(new TypeError('offline')), { code: 'NetworkError' }],
  ])('maps a failed request to a coded error (%#)', async (respond, expected) => {
    const { network, reader } = setup();
    network.failOnce(respond, (url) => url.pathname.startsWith('/xrpc/'));
    await expect(reader.getRecord(GAME_URI)).rejects.toMatchObject(expected);
  });
});

describe('listRecords', () => {
  it('pages through a collection newest first', async () => {
    const { network, reader } = setup();
    const rkeys = Array.from({ length: 120 }, (_, i) => `3m3${String(i).padStart(10, 'a')}`);
    rkeys.forEach((rkey) => network.put(BOB, GAME, rkey, CID[1], game()));
    const listed = await collect(reader.listRecords(BOB, GAME));
    expect(listed.map((record) => record.uri)).toEqual(
      [...rkeys]
        .sort()
        .reverse()
        .map((rkey) => uri(BOB, GAME, rkey)),
    );
    // Three full pages, then an empty one that ends the loop.
    expect(network.calls('listRecords')).toHaveLength(4);
  });

  it('skips records that are outside the requested repo or collection', async () => {
    const { network, reader } = setup();
    network.failOnce(
      () =>
        new Response(
          JSON.stringify({
            records: [
              { uri: uri(BOB, GAME, '3m2bbbbbbbb22'), cid: CID[1], value: game() },
              { uri: uri(ALICE, 'app.bsky.feed.post', '3m2cccccccc22'), cid: CID[2], value: {} },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      (url) => url.pathname.endsWith('listRecords'),
    );
    const listed = await collect(reader.listRecords(ALICE, GAME));
    expect(listed).toEqual([]);
  });
});

describe('parseAtUri', () => {
  it('splits an AT-URI', () => {
    expect(parseAtUri(GAME_URI)).toEqual({ did: ALICE, collection: GAME, rkey: '3m2aaaaaaaa22' });
  });

  it.each([undefined, 42, 'https://example.com', 'at://not-a-did/x/y'])(
    'returns null for %s',
    (value) => expect(parseAtUri(value)).toBeNull(),
  );
});

describe('asCodedError', () => {
  it('keeps coded errors and wraps anything else', () => {
    const coded = codedError('HttpError', 'nope');
    expect(asCodedError(coded)).toBe(coded);
    const wrapped = asCodedError(new TypeError('bug'));
    expect(wrapped).toMatchObject({ code: 'UnexpectedError' });
    expect(wrapped.cause).toBeInstanceOf(TypeError);
  });
});
