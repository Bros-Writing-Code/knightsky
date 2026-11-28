# AT Protocol Integration

Authors: James Keys and Adarsh Shetkar

## OAuth Sign In

[auth.js](./auth.js) signs a player in with their AT Protocol account. The app is a browser-only public client (no server, no secret), see [ADR 0007](../../docs/adr/0007-atproto-oauth-sign-in.md).

| Function | What it does |
| --- | --- |
| `initAuth()` | Call once on page load. Finishes a sign in redirect if the URL has one, otherwise restores the saved session. Returns the session, or `undefined` when nobody is signed in. |
| `signIn(handle)` | Sends the browser to the player's PDS to approve the sign in. The page comes back through `initAuth()`. |
| `getProfile(did)` | Looks up `{ handle, displayName? }` from Bluesky's public AppView. Needs no sign in and throws if the lookup fails. |
| `signOut(session)` | Signs the session out. |
| `onSessionDeleted(callback)` | Runs when the library deletes a session (happens on any sign out attempt, even if failed). |

The session only carries the DID (`session.sub`), so use `getProfile` to show a name. Only the `atproto` scope is requested for now. Locally the library's loopback client is used. In production `client-metadata.json` is generated from `SITE_URL`, see [Deployment](../../docs/deployment.md).

## Lexicon

Our overall design principle is to treat opponents' moves as untrusted user data. We always validate their moves on our client with the chess engine to ensure that we agree on the current state of the game.

### [Game](./lexicons/app/knightsky/game.json)

`app.knightsky.game` is a mutable record with a TID key. It represents an invitation when `challenge` is absent, or an acceptance when present. The owner updates the same record after a move, draw offer, or game end.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `opponent` | DID string | Yes | The opposing player's DID; the record owner's DID comes from their repository. |
| `color` | String: `white` or `black` | Yes | The record owner's color. |
| `challenge` | `com.atproto.repo.strongRef` | No | Reference to the challenger's game record and its CID at acceptance. Present only on the accepting player's record and retained on later updates. |
| `pgn` | String | Yes | Full mainline move history from the standard starting position. May be empty before the first move; maximum 262,144 UTF-8 bytes. Clients must replay and validate the moves. |
| `fen` | String | Yes | Six-field position after replaying `pgn`, or the standard starting position before any moves. Must be 1–256 UTF-8 bytes. Clients must validate it against the replayed position. |
| `status` | String: `active`, `drawOffered`, or `ended` | Yes | `active`: the game is in progress. `drawOffered`: the game is in progress and the record owner offers a draw. `ended`: the record owner considers the game over. |
| `termination` | String; known values below | When `ended` | How the game ended. Other nonempty strings are also valid. Clients must verify it against the replayed history and the opponent's record. |
| `result` | String: `win`, `loss`, or `draw` | When `ended` | The outcome from the record owner's perspective. Clients must verify it. |
| `clock` | Object; fields below | No | Present in timed games, absent in untimed games. |

| `clock` field | Type | Required | Description |
| --- | --- | --- | --- |
| `initialMs` | Integer ≥ 1 | Yes | Each player's starting time in milliseconds. Set by the challenger, copied by the accepting player, and never changed. |
| `incrementMs` | Integer ≥ 0 | Yes | Milliseconds added to a player's clock after each of their moves. Set and copied like `initialMs`. |
| `remainingMs` | Integer ≥ 0 | Yes | The owner's time left in milliseconds after their latest move, including any increment. Equals `initialMs` before the owner's first move. |
| `movedAt` | Datetime | No | When the owner made their latest move. Absent before the owner's first move. A client rebuilding from the PDS uses it to work out how long the current turn has run. |

The Lexicon can't make `termination` and `result` conditionally required, so clients enforce "required when `ended`". Each player can only write their own repository, so each client marks its own record `ended` once it sees the game is over.

Each client trusts the opponent's `remainingMs` and `movedAt`, but still checks that `remainingMs` never rises by more than `incrementMs`, `movedAt` never goes backwards, and `initialMs` and `incrementMs` match the challenger's record. A player who runs out of time writes nothing, so the opponent's client detects the flag and writes `ended` / `timeout` / `win`.


| Known termination | Meaning |
| --- | --- |
| `checkmate` | A king is checkmated. |
| `resignation` | A player resigned. |
| `agreement` | Draw by agreement: one player set `drawOffered`, the other accepted by setting `ended`. |
| `timeout` | A player ran out of time. |
| `stalemate` | The side to move has no legal moves and is not in check. |
| `insufficientMaterial` | Neither side can checkmate. |
| `threefoldRepetition` | The same position occurred three times. |
| `fivefoldRepetition` | The same position occurred five times. |
| `fiftyMoveRule` | Fifty moves by each side without a capture or pawn move. |
| `seventyFiveMoveRule` | Seventy-five moves by each side without a capture or pawn move. |

### [Reject](./lexicons/app/knightsky/reject.json)

`app.knightsky.reject` is a record with a TID key that requests a correction to a specific version of an opponent's game record. A rejection does not end the game or replace the last accepted state.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `subject` | `com.atproto.repo.strongRef` | Yes | The opponent's game record URI and the CID of the exact offending update, not just its latest version. |
| `reason` | Nonempty string | Yes | A reason code. The known values below are nonexhaustive; other nonempty strings are also valid. |
| `message` | String | No | Human-readable explanation, limited to 200 grapheme clusters and 2,000 UTF-8 bytes. Treat as untrusted plain text, not markup or instructions. |

| Known reason | Meaning |
| --- | --- |
| `wrongTurn` | The opponent moved out of turn. |
| `badPrev` | The move history does not extend the last accepted history by exactly one ply. |
| `illegalMove` | The appended move is illegal. |
| `badFEN` | The supplied FEN differs from the position computed from PGN. |
| `noDrawOffer` | The update accepts a draw by agreement that the rejecting player has not offered. |
| `badClock` | The clock or a timeout claim does not match the agreed time control and observed timing. |

There are probably more rejection reasons that need to be added. In particular, we need to handle false claims for various termination conditions like timeout, checkmate, etc. We'd need to be able to reject a player declaring victory prematurely, or something like that. 

## How a Game is Played

What follows is a description of the communication flow between clients.

1. Signed in player Alice wants to challenge Bob to a game of chess.
2. Alice types in Bob's handle in the frontend and clicks a button.
3. Alice's client takes the following actions:
   1. Resolves Bob's handle to his DID. Assuming it finds it...
   2. Creates a game record with an empty PGN and the starting FEN, Alice as the white player, Bob as the challenged player.
   3. Creates a URL that includes the AT URI for the new game record.
4. Alice sends this to Bob.
5. Bob opens the link and signs into the chess app with his atproto handle.
6. Bob's client...
   1. Parses the AT URI, which gives the challenger's DID + collection + rkey.
   2. Resolves the challenger's DID to a PDS endpoint.
   3. Gets Alice's game record from that PDS.
   4. Checks the `opponent` field in that record and matches it against Bob's DID. If they don't match, this challenge is for someone else.
   5. If it's a match, Bob writes his own `game` record, which strong refs the challenge and sets his color to be opposite Alice's and starts watching the challenger's repo.
7. Alice's client listens for `game` records from Bob's DID whose `challenge` points at her record.
8. Alice makes a move on the UI.
9. The client updates her `game` record by appending the move on the PGN notation and rewriting the FEN.
10. Bob's client detects the update with his listener.
11. If Alice updated her status to `ended`, the game is over. Bob's client checks her `termination` and `result`, then marks his own record `ended`.
12. Bob's client compares the PGN to his PGN.
    1. It checks whether it was Alice's turn. (fail -> wrongTurn)
    2. It checks whether exactly one new move was appended beyond the accepted state (fail -> badPrev)
    3. If the previous check passed, it checks the one new move that was added with the chess engine (fail -> illegalMove)
    4. It computes the resulting FEN from Alice's full PGN and matches it to Alice's FEN (fail -> badFEN)
13. Bob's client makes further checks on the rest of the `game` record
    1. It checks whether the clock calculations are correct if it's a timed game (fail -> badClock) 
    2. It checks whether the status of the game is still accurate, especially looking for premature termination conditions (fail -> noDrawOffer or something similar)
14. Bob makes a move on the UI.

If Alice's listener notices that Bob rejected her move while she's waiting for him to take his turn, she would ideally rectify the mistake by making another update to her game record.

- If her most recent move is an illegal move, she could just choose a different move
- If she miscomputed the FEN, she could try computing it again
- If she appended too much information to the PGN, she could fix those kinds of errors
- If Alice and Bob disagree on the history of the game up to that point, we sort of reach an unresolvable deadlock, especially if Bob keeps sending more reject records. At that point, it would be best to leave the game unfinished. We don't auto-end the game. We should only end games for one of the known terminations above, such as checkmate, resignation, a draw by agreement, or a timeout.

If Alice fixes her error and writes the fix to her repo, then Bob would take his turn and play would continue as normal.

### How a Game is Played

What follows is a description of the communication flow between clients. 

1. Signed in player Alice wants to challenge Bob to a game of chess.
2. Alice types in Bob's handle in the frontend and clicks a button.
3. Alice's client takes the following actions:
  1. Searches for Bob's DID using his handle. Assuming it finds it... 
  2. Creates a game record with an empty PGN and the starting FEN, Alice as the white player, Bob as the challenged player.
  3. Creates an url that includes the AT URI for the new game record.
4. Alice sends this to Bob
5. Bob opens the link and signs into the chess app with his atproto handle
6. Bob's client...
  1. parses the AT URI, which gives the challenger's DID + collection + rkey.
  2. resolves the challenger's DID to a PDS endpoint
  3. gets Alice's game record from that PDS
  4. Checks the `opponent` field in that record and matches it against Bob's DID. If they don't match, this challenge is for someone else.
  5. If it's a match, Bob writes his own `game` record, which strong refs the challenge and sets his color to be opposite Alice's and starts watching the challenger's repo. 
7. Alice's client listens for `game` records from Bob's DID whose `challenge` points at her record.
8. Alice makes a move on the UI.
9. The client updates her `game` record by appending the move on the PGN notation and rewriting the FEN. 
10. Bob's client detects the update with his filtered Jetstream listener.
11. If Alice updated her status to `resigned`, the game is over and Bob takes no further actions.
12. Bob's client compares the PGN to his PGN.
  1. It checks whether it was Alice's turn. (fail -> wrongTurn)
  2. It checks whether exactly one new move was appended beyond the accepted state (fail -> badPrev)
  3. If the previous check passed, it checks the one new move that was added with the chess engine (fail -> illegalMove)
  4. It computes the resulting FEN from Alice's full PGN and matches it to Alice's FEN  (fail -> badFEN)
13. Bob makes a move on the UI.

If Alice's Jetstream listener notices that Bob rejected her move while she's waiting for him to take his turn, she would ideally rectify the mistake by making another update to her game record.
- If her most recent move is an illegal move, she could just choose a different move
- If she miscomputed the FEN, she could try computing it again
- If she appended too much information to the PGN, she could fix those kinds of errors
- If Alice and Bob disagree on the history of the game up to that point, we sort of reach an unresolvable deadlock, especially if Bob keeps sending more reject records. At that point, it would be best to leave the game unfinished. We don't auto-end the game. We should only end games if there's a clear winner via checkmate, an agreed upon draw (currently planned), a timeout (currently planned), or one of the players forfeits.
If Alice fixes her error and writes the fix to her repo, then Bob would take his turn and play would continue as normal.

## Game Watcher

[watchGames.js](./watchGames.js) keeps every ongoing game of the signed-in player up to date while the tab is open. Call `watchGames({ myDid, onChange, onError })` once after sign in. It returns:

- `add(myRecordUri)`: watch a game created in this tab.
- `list()`: a snapshot of every game.
- `stop()`: call it on sign out.

It finds your games in your own repo, reads each opponent's side from their PDS, then follows one Jetstream v2 subscription filtered to your DID and your opponents' DIDs. Every change arrives through `onChange(gameId, { type, game, rejection? })`, where `type` is `added`, `myRecordUpdated`, `opponentUpdated` or `rejected`.

The module checks records against the lexicons but knows nothing about chess, so the UI validates moves with the engine. [pds.js](./pds.js) holds the public PDS reads it uses.

See the [spec](../../docs/specs/multi-game-listener.md) for the design and its trade-offs.

## Game Watcher Tests

Run the tests with `npm test -- src/atproto/testing/watchGames.test.js src/atproto/testing/pds.test.js`.

The tests drive the real `@atcute/jetstream` client with a fake WebSocket and a fake `fetch` from [fakes.js](./testing/fakes.js). They cover:

- discovery at startup;
- live updates and acceptances;
- adding games, from this tab or another device;
- rejections, including ones that arrive before the version they reject;
- PDS reads racing the stream;
- reconnect, fallback and retry behavior.

## Auth Tests

[auth.test.js](./testing/auth.test.js) tests `getProfile` with a mocked `fetch`: a successful lookup (and the request URL), an HTTP error, and a network failure. The OAuth redirect flow needs a real browser and PDS, so it is checked by hand (see the browser checklist in the [demo spec](../../docs/specs/chessground-demo.md)).

## Lexicon Tests

Run the tests with `npm test -- src/atproto/testing/lexicons.test.js`

[lexicons.test.js](./testing/lexicons.test.js) uses Vitest to run 98 Lexicon tests (counting each `.each(...)` case separately). They fall into the following general categories:

- ensuring that the Lexicon schemas are valid and tolerant to future additional fields/unknown rejection codes.
- ensuring that the game records handle standard variants (like starting challenge with no challenge reference), and standard use cases (valid move update, challenge response, resignation, draw offer and agreement, known and future termination values, timed and untimed games, timeout)
- ensuring that the game records fail validation on missing required fields or string fields that are too long
- ensuring that the reject records handle standard known reason variants and optional message
- ensuring that the reject record message field bounds apply correctly
- ensuring that the strong reference fields in the two records (`game.challenge` and `reject.subject`) fail validation if the reference object is invalid (missing a URI/CID or those fields are malformed)

These tests exist to check record structure. They don't verify anything that has to do with chess rules. In fact, one test ensures that a record passes the validator even if the PGN or FEN is invalid. That's the engine's responsibility.
