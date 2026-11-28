# Multi-game listener

Status: implemented in `src/atproto/watchGames.js` (stream and game state) and `src/atproto/pds.js` (PDS reads). Replaces the single-game `watchOpponentGame` from the closed PRs #105 and #106.

## Goal

A player can have many ongoing games at once (no hard limit; at least ~99) and switch between them at any time. While the tab is open, the UI learns about every change to any of those games without a reload: an opponent's move, a rejection, an acceptance of an invitation, or the player's own move from another tab or device.

## Scope

In scope: listening only.

Out of scope:

- Writing moves and reject records (waits on the PGN parser).
- Discovering incoming invitations from players not already in a game with you.
- Notifications while the tab is closed (there is no server to push them).
- The UI itself (game list, board screen, toasts). This spec defines only the contract the UI builds on.

## Terms

See `docs/ubiquitous_language.md`.

- **Ongoing game**: your record's status is not `ended`.
- **Game ID**: the invitation's URI. For the challenger, this is their own record's URI. For the accepting player, it is `challenge.uri` on their record.

## Design

### Stream

- One `@atcute/jetstream` `subscribeEvents()` subscription to Bluesky's public Jetstream v2 (`wss://jetstream.us-west.bsky.network`).
- Filters: `collections` = `app.knightsky.game`, `app.knightsky.reject`; `kinds` = `commit`; `dids` = your DID plus the DID of every opponent in your ongoing games.
- Your own DID is always in the filter. This keeps tabs and devices in sync. It also means the filter is never empty, because an empty `dids` filter would receive every account on the network.
- Commits from your own DID are reported as "my record changed", not as an opponent move.

### Adding an opponent

Jetstream v2 does not support changing filters on an open socket. Tested against the public endpoint: sending an `options_update` frame closes the socket with `1008 unexpected data message`.

To add a new opponent:

1. Start a new subscription with the larger DID list, from the live tip. The old subscription keeps running.
2. When the new one opens, keep the old one running for 5 more seconds, then abort it. The new subscription starts at the live tip, so events the server already sent the old socket may still be in flight; the grace period covers them. Events from the overlap are deduplicated by CID.
3. Then read the new game from the PDS.

If the opponent is already in the filter, there is nothing to do. Requests made in the same tick, or while my repo is being listed, are batched, so discovering many games at startup opens one subscription however many pages the listing takes.

The new subscription does not resume from the old one's cursor. `@atcute/jetstream` 2.2.1 compares a timestamp cursor (≥ 1e15) with event sequence numbers in its duplicate check, so it would drop every event. A seq cursor would work but is often unknown, because a quiet game sends no events.

### PDS reads racing the stream

A PDS read result is dropped if the stream delivered the same record after the read started. The stream is at least as new and will bring anything newer.

If the opponent rejects a version of my record that the stream has not delivered yet, the rejection waits until that version arrives. A rejection of an older version is stale and is never reported.

### Removing opponents

Opponents are never removed during a session. Finished games go quiet. The next page load builds the filter from ongoing games only.

### Long gaps and expired cursors

Jetstream rejects an expired cursor before the WebSocket upgrade, and the client only sees a connection failure. After 5 failed connections in a row on a subscription that has a cursor, a fresh subscription from the live tip replaces it and every game is re-read from the PDS.

A reconnect with no cursor to resume from (no event yet) also re-reads every game.

The first failure in a streak is reported as `NetworkError` with a `null` game ID, once across all subscriptions until one opens again.

A failed PDS read is retried with exponential backoff (1 s up to 30 s). At most one retry waits per game, plus one for listing my repo, however many syncs fail.

### Discovery

When the module starts, it lists your repo's `app.knightsky.game` records and keeps the ongoing ones.

For each ongoing game, it then gets the opponent's record:

- If you accepted, it reads the challenger's record from `challenge.uri`.
- If you are the challenger, it finds the opponent's acceptance (the oldest if there are several), or waits for one.

### Validation and identity

- Every record from another repo is checked against the Knightsky lexicons with `@atproto/lexicon`. Jetstream only validates the event envelope.
- DID → PDS resolution uses `@atproto-labs/did-resolver`, which `@atproto/oauth-client-browser` already depends on.

### The module does not know chess

The module returns records only. The UI decides whose turn it is and validates moves through the engine. Until the PGN parser lands, the UI can read the side to move from the record's `fen` for display.

## Module contract

```js
const games = watchGames({ myDid: session.sub, onChange, onError });
games.add(myRecordUri); // a game started in this tab
games.list();           // snapshot of every game seen this session
games.stop();           // sign-out or session deleted
```

The module takes `myDid`, not the session, because every read is public.

A game snapshot is `{ gameId, opponentDid, myRecord, opponentRecord }`. Each record is `{ uri, cid, value }`. `opponentRecord` is `null` while an invitation is unaccepted.

- `onChange(gameId, { type, game, rejection? })` is the only event callback. It always carries the whole updated snapshot. `type` is one of:
  - `added`
  - `myRecordUpdated`
  - `opponentUpdated`
  - `rejected`: the opponent rejected the current version of my record; `rejection` is set.
- `onError(gameId | null, error)`:
  - A `gameId` means the error concerns one game, e.g. `InvalidRecord`, `RecordNotFound`.
  - `null` means the error concerns the whole stream, e.g. `NetworkError`.
  - Codes: `PdsResolutionFailed`, `NetworkError`, `RateLimited`, `HttpError`, `RecordNotFound`, `InvalidRecord`, `UnexpectedError`.
- Ended games stay in `list()` until the next page load.
- Tests pass a fake WebSocket through the `webSocket` option. `partysocket` takes it as `ws.WebSocket`.

## Known limitations

- Every sync lists all of the player's game records, including finished ones. This is fine for hundreds of games but grows with history.
- Around a (re)subscription, an opponent version can briefly arrive out of order. The protocol tolerates this: a rejection of a stale version is dropped by the opponent's client.
- Playing against yourself (opponent = your DID) is not supported.
- The bundle cost of `@atcute/jetstream` is not measured yet, because the demo does not import the module.

## Trade-offs

- **Why one socket per opponent set and not one per game.** One socket per game is simpler, but a player with many games would open many connections and repeat the PDS and DID lookups for each one.
- **Why not subscribe without a DID filter.** Without a filter, the client would receive all Knightsky traffic on the network. After a reconnect it would replay everyone's moves made during the gap.
- **Why `@atcute/jetstream`.** It is smaller and more actively released than `@bsky/jetstream` (87 KB vs 540 KB unpacked; 13 releases vs 2). It needs no `@atproto/lex` peer dependency. The cost is that it is maintained mostly by a single person.
