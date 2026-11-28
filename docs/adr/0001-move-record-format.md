# ADR 0001: Game record format on ATproto (PGN + FEN)

- **Status:** Proposed
- **Date:** 2026-11-22
- **Deciders:** Engine team (Keanu, Russel, Congke), AT team (James)
- **Related:** [Lexicon Definition](../../src/atproto/lexicons/app/knightsky/) and [AT Protocol README](../../src/atproto/README.md)

## Terminology

| Term | Meaning | Where it appears |
|---|---|---|
| **Board state** | Only where each piece is: what a spectator sees looking at the board. No turn, castling or other rule information. | **Field 1 of a FEN** (piece placement), e.g. `rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR` |
| **Game state** | Board state **plus** everything the rules need that can't be seen on the board: side to move, castling rights, en passant square, halfmove clock, fullmove number. | **All 6 fields of a FEN** (`fen`), e.g. `rnbqkbnr/…/RNBQKBNR b KQkq e3 0 1` |
| **Full game history** | Game state plus every earlier position, needed for threefold repetition. | Replayed from the record's `pgn`. |
| **`GameState` (engine type)** | The engine's internal object holding the game state + history. Never sent over the network. | Engine code only (`types.js`) |

Why board state alone isn't enough: the same piece placement can be white's or black's turn, with or without castling rights (a king that moved and returned looks identical), and with or without an en passant capture available. Rules depend on all of these, so records carry the full game state (FEN), not just the board.

```
rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR  b  KQkq  e3  0  1
└──────────────── board state ───────────────┘ └────── rule info ──────┘
└───────────────────────── game state (fen) ───────────────────────────┘
```

## Context

Each player's browser runs its own copy of the chess engine. There is no game server: moves travel as records in each player's own repository on their PDS, and the opponent's client reads them.

We need to decide what a client publishes when a player makes a move. Requirements:

1. **Each client is the referee.** The receiver must be able to check that a move is legal, not trust the sender.
2. **Reload and join.** A client must be able to restore a game after a refresh, or open a game in progress.
3. **Detect desync.** If two clients disagree about the position (bug, old version, missed record), we should notice immediately.
4. **Stable network format.** Internal engine types (`GameState`) will change during development; saved games and the AT team's code must not break when they do.
5. **Bounded records.** One record per player, per game, rewritten on each move. 

Each player can only write to their own repo, and `com.atproto.repo.listRecords` can't filter records by field. So the record has to have a field that specifically says whether the game is finished.

## Decision

Each client publishes **one game record** when a game begins, and updates that one record on each move. A move appends exactly one action to the `pgn` field, and then computes the resulting FEN notation and writes that to the `fen` field. The board state is the first field of that FEN. The internal `GameState` object is never sent over the network. 

### Game record (created once, updated on each move)

Alice sends Bob an invitation to play a game and Bob accepts. His client creates a record, which after a few moves looks like this:

```jsonc
{
  "$type": "app.knightsky.game",
  "opponent": "did:plc:alice...",
  "color": "black",
  "challenge": { // optional, exists only in the acceptance record, not the invitation record
    "uri": "at://did:plc:alice.../app.knightsky.game/3k2x...",
    "cid": "..."
  },
  "pgn": "...", // full pgn of the game
  "fen": "...", // current fen of the game
  "status": "active", // could also be drawOffered or ended
  "clock": { // optional, only used by games with clocks
    "initialMs": 600000, // starting clock value in ms
    "incrementMs": 2000, // amount added to clock per each move in ms. 
    // Used to prevent race to the bottom scenarios where players have only fractions of a second to move near the end of their clock.
    "remainingMs": 577000, // time remaining on owner's clock after their last move, including the increment
    "movedAt": "2026-11-23T05:38:17Z" // timestamp of the owner's last move
  }
}
```

Here's an example of Alice's invitation-style game record at the end of a game.

```jsonc
{
  "$type": "app.knightsky.game",
  "opponent": "did:plc:bob...",
  "color": "white",
  "pgn": "...",
  "fen": "...",
  "status": "ended",
  // termination is required when status is ended (clients enforce this; the lexicon can't).
  // there are many more variants available. See the atproto README (src/atproto/README.md) for more details.
  "termination": "resignation", 
  "result": "loss", // also required when status is ended
  "clock": {
    "initialMs": 600000,
    "incrementMs": 2000,
    "remainingMs": 192000,
    "movedAt": "2026-11-23T05:52:30Z"
  }
}
```

### Draw by Agreement

If Alice wants to request a draw, she can do so by updating her `status` field to `drawOffered`, along with making a move. The offer lapses when Bob moves, and Alice's next update sets her `status` back to `active`. If Bob accepts while the offer stands, he sets his `status` to `ended`, the `termination` field to `agreement` and the `result` field to `draw`. Alice then marks her own record `ended` the same way. If he rejects the request, he just plays on and submits a move. Accepting an offer that has lapsed or was never made is rejected with `noDrawOffer`.

### Reject Record

If Bob makes a move that Alice's client doesn't like: i.e. he moves out of turn, makes an illegal move, or miscalculates the `fen` from the `pgn`, Alice would send him a reject record. Reject records are straightforward, containing `subject` and `reason` fields, and an optional human-readable `message` field. The `subject` field is a strong ref, like the optional `challenge` field in the `game` record. The `subject` field references a particular revision of Bob's `game` record. The standard reasons for rejection are `wrongTurn`, `badPrev`, `illegalMove`, `badFEN`, `noDrawOffer`, and `badClock`. Other reasons not listed are allowed by the lexicon. 

### Client flow

**Sending**
1. Player makes a move in the UI.
2. `applyMove(state, uci)` → new state, or an error, in which case the move isn't sent.
3. Update your own game record: append the move to `pgn`, write `fen`, and in timed games, `clock.remainingMs` and `clock.movedAt`.

**Receiving**
1. The opponent listener reports a new version of their record.
2. Check in order: `wrongTurn`, then `badPrev` (exactly one ply appended), then `illegalMove`, then `badFEN`. Also check `noDrawOffer` and `badClock` where relevant.
3. If a check fails, write an `app.knightsky.reject` for that exact CID. If all pass, it becomes accepted history. 
4. If the opponent's record is `ended`, verify `termination` and `result`, then mark your own record ended.

**When your update is rejected:** if the opponent rejects your current version, fix your record and update it again. A rejection shouldn't end the game.

**Reloading**
- Fetch both game records and replay `pgn` from the standard starting position.

## Consequences

**Positive**
- Every move is validated by the receiver; a client cannot inject an illegal position.
- Desync is detected on the first mismatched move.
- The network format is independent of internal types; `GameState` can change freely.
- Each player's repo holds one complete record of the game, already in PGN.
- Finished games can be filtered by `status` without replaying them.

**Negative / trade-offs**
- The record grows with the game, up to 256 KB.
- `fen` is redundant with `pgn` (about 60 extra characters per record). Accepted for desync detection.
- Threefold-repetition detection needs the full move history, not just the latest FEN, so a full replay is required for draw rules.
- Both clients must use the same FEN rules (e.g. when to write an en passant square). Engine tests must cover `GameStatetoFEN` output exactly.
- We need to implement a `pgn` parser (#69).
- Each update rewrites the whole history, so the receiver has to check that exactly one ply was appended.
- `termination`, `result`, and `clock` are all claims that clients must verify.
- Rebuilding the clock from the opponent's PDS trusts their `remainingMs` and `movedAt`.
- Removing `status: resigned` from the published lexicon was a one-time breaking change, accepted because no client wrote game records yet (see [knightsky.app account](../knightsky-account.md)).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| **One move record per move (UCI/SAN + FEN, prev ref)** | It gave an auditable sequence of moves, but having one clear record of the game was a lot simpler, especially if you want to be able to view completed games. |
| **PGN only** (no `fen`) | Works if every client is bug-free, but desync is silent. `fen` is a check, `pgn` is the source of truth. |
| **FEN only** (no move) | Receiver can't easily tell which move was played or whether it was legal. |
| **Storing `ply` / `moveNumber` explicitly** | Redundant with `fen`. |
| **Keeping game results derived only** | No way to record a draw by agreement or timeout. |
| **One large status enum** | Awkward for filtering and no stored result. |
| **UCI move list instead of PGN (SAN)** | UCI is simpler to parse and generate, but PGN is the standard format for a whole game and readable by any chess tool. The cost is a PGN parser (#69), and each SAN move needs the position to read. |
| **Separate top-level clock fields** (`timeControl`, `clockMs`, `movedAt`) | The lexicon couldn't require them together. One optional `clock` object makes a game either timed or untimed. |
