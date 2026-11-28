# ADR 0008: Multi Game Opponent Listener

- **Status:** Proposed
- **Date:** 2026-11-25
- **Deciders:** Atproto Team
- **Related:** [Multi-Game Listener Spec](../specs/multi-game-listener.md)

## Context

Clients need to listen to their opponents' repos. This applies for any game in their repo that is labeled `active` or `drawOffered`, which we call "ongoing games." We need this because we want to support players having multiple ongoing games simultaneously. On the home screen, users should be able to track their ongoing games live. When they're strategizing on the game screen, they should get a notification that another one of their games has received a move. Without a backend server to listen for them, clients must listen to all ongoing games themselves.

Bluesky runs a service called "Jetstream" which delivers atproto events in plain JSON over a WebSocket. Clients can filter for the kinds of records they want when they connect to the WebSocket. One can live tail the Jetstream, or replay historical events to catch up to the latest ones. We can use this service to watch opponents' repos for updates to `game` records or `reject` records.

## Considered Options

- **One socket per game.** We rejected this since it's relatively simple to filter our WebSockets by multiple DIDs. 
- **No DID filter at all.** We rejected this because of bandwidth constraints, and because a reconnect would force clients to replay all the traffic on the network.
- **@bsky/jetstream instead of the atcute implementation**: We rejected it because this package is a lot larger and has seen fewer updates since its release.

## Decision

We install `@atcute/jetstream`, a community supported jetstream SDK. This lets us subscribe to the Jetstream, filtering by lexicon namespace and DID to only receive `app.knightsky.game` and `reject` records from the ongoing games listed in our own repo. For DID resolution, we use code from `@atproto-labs/did-resolver`.

The Jetstream v2 server does not support sending `options_update` while the socket is open. This means that **if we need to start listening to a new repo** (if we create an invitation, or accept one), **we must close the WebSocket, update the query parameters with the new opponent's DID, and then open a new socket connection.** This process could cause us to miss events from other games, so we handle that by opening the new WebSocket while the old one is still open. We keep the old one open for 5 more seconds, then close it deduplicate events. If the WebSocket connection was already configured to listen to a particular opponent's repo, and we start a new game with that opponent, we won't need to reconnect the WebSocket.

To keep multiple devices or tabs in sync, we include our own DID in the subscription filter. This also prevents us from having an unfiltered subscription when we don't have any ongoing connections.

**This listener doesn't know anything about chess.** Validation is the responsibility of another module. The listener will validate whether the records it receives are valid according to the lexicon, but this lexicon cannot express valid vs. invalid FEN or PGN notation.

## Consequences

### Positive

- Listening to multiple games requires only one WebSocket.
- UI gets a pretty simple API, with just a handful of callbacks to attach.
- `@atproto-labs/did-resolver` was already installed indirectly by `@atproto/oauth-client-browser`.

### Negative

- Forced to reconnect on any update to the list of DIDs we're tracking.
- This is a feature for which not having a backend introduces a lot of client-side complexity.
- Future support for open invitations would require an unfiltered subscription to all traffic on our namespace, or a backlink index like [Constellation](https://tangled.org/microcosm.blue/microcosm-rs/tree/main/constellation).
- `@atcute/jetstream` is mostly maintained by one person.
- We now depend on Bluesky's public Jetstream instance.
