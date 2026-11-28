# chess engine

keanu
chris
russel

## moveGenerator

All seven functions take a `GameState` and a starting `Square` (`{ row, col }`).

| Function | Output | Purpose |
| --- | --- | --- |
| `moveGenerator(state, selectedSquare)` | `Square[]` | Selects the current player's piece and returns legal target squares, excluding moves that leave its king in check. |
| `getPossibleMovesPawn(state, square)` | `Square[]` | Returns candidate pawn moves, including captures and en passant. |
| `getPossibleMovesBishop(state, square)` | `Square[]` | Returns candidate diagonal moves. |
| `getPossibleMovesKnight(state, square)` | `Square[]` | Returns candidate knight jumps. |
| `getPossibleMovesRook(state, square)` | `Square[]` | Returns candidate horizontal and vertical moves. |
| `getPossibleMovesQueen(state, square)` | `Square[]` | Returns candidate diagonal, horizontal, and vertical moves. |
| `getPossibleMovesKing(state, square)` | `Square[]` | Returns candidate king moves, including castling when its conditions are met. |

The six `getPossibleMoves...` functions do not filter out moves that leave the player's king in check. Use `moveGenerator` for legal moves, such as UI move highlighting.

## gameState

These functions are exported from `gameState.js`.

| Function | Output | Purpose |
| --- | --- | --- |
| `isInCheck(state)` | `boolean` | Returns whether the side to move's king is attacked. |
| `getGameStatus(state)` | `{ status, winner, drawReason }` | Returns `checkmate`, `stalemate`, `draw` (insufficient material, fifty-move rule, threefold repetition), or `active` for the current position. Checkmate and stalemate take priority. |
| `isInsufficientMaterial(state)` | `boolean` | True for K vs K, K+B vs K, K+N vs K, or kings plus bishops all on one square color. |
| `applyMove(state, uci)` | `Result<GameState>`: `{ ok: true, value: newState }` or `{ ok: false, error: string }` | Validates and applies a UCI move without changing `state`; updates the board, turn, special-move fields, history, and game status. |

## Public API (`src/engine/index.js`)

Other teams import **only** from `src/engine/index.js`. Everything else in this folder is internal and may change.

**Contract:** every function is pure. It takes data and returns new data, never mutates its input, and never stores a game. The caller (UI / AT layer) owns every `GameState`. Squares are `{ row, col }` with row 0 = rank 8 and col 0 = file a; 0x88 indexes never leave the engine. Untrusted input (UCI from the network, move lists) returns a `Result`: `{ ok: true, value }` or `{ ok: false, error }`.

```js
import { createGame, toGrid, legalMovesFrom, applyMove, getGameStatus } from '../engine/index.js';

let state = createGame();                                   // fresh game
render(toGrid(state));                                      // 8x8 array, grid[row][col]

const targets = legalMovesFrom(state, { row: 6, col: 4 });  // e2 → [{row:5,col:4}, {row:4,col:4}]

const result = applyMove(state, 'e2e4');
if (result.ok) state = result.value;
else showError(result.error);

const { status, winner } = getGameStatus(state);           // 'active' | 'checkmate' | 'stalemate' | 'draw'
```

| Function | Returns |
| --- | --- |
| `START_FEN` | Starting position FEN string |
| `createGame(fen = START_FEN)` | New `GameState` (fresh object every call); status already set, so a checkmate/stalemate FEN starts finished |
| `getPiece(state, square)` | Copy of the `Piece`, or `null` |
| `toGrid(state)` | 8×8 array of `Piece \| null` for rendering (copies) |
| `legalMovesFrom(state, square)` | `Square[]` of legal destinations for one piece (king safety included); `[]` once the game is over |
| `legalMoves(state)` | `string[]` of every legal move as UCI (promotions listed once per piece) |
| `isValidMove(state, uci)` | `boolean`; never throws |
| `applyMove(state, uci)` | `Result<GameState>` (see `gameState` above) |
| `replayMoves(ucis, startFen = START_FEN)` | `Result<GameState>`; the error names the failing move |
| `isInCheck(state)` | `boolean` |
| `getGameStatus(state)` | `{ status, winner, drawReason }` |
| `GameStatetoFEN(state)` | FEN string (to load a FEN, use `createGame(fen)`) |
| `moveToUCI(move)` / `UCItoMove(uci)` | UCI string / `Move` |
| `toSAN(state, uci)` | SAN string, e.g. `'Nf3'`, `'exd6'`, `'O-O'`, `'e8=Q+'`, `'Qh4#'`; throws on an illegal move |
| `fromSAN(state, san)` | `Result<string>` with the UCI move; accepts `+`/`#`/`!?`, `0-0`, and `e8Q` without `=` |
| `replayPGN(pgn)` | `Result<GameState>` from the standard start; `''` is a game with no moves; the error names the failing move |
| `appendMove(pgn, uci)` | `Result<{ pgn, state }>`: checks the whole PGN, adds the move, returns canonical PGN and the new state |
| `nextMove(oldPgn, newPgn)` | `Result<{ uci, san, color, state }>`: checks the new PGN is the old one plus exactly one legal move. Errors also carry a `code`: `INVALID_PREVIOUS`, `GAME_OVER`, `INVALID_PGN`, `CHANGED_MOVE`, `NO_NEW_MOVE` or `TOO_MANY_MOVES` |
| `printBoard(state.board)` | ASCII board (debug only) |

**Promotion:** a pawn moving to the last rank (row 0 for White, row 7 for Black) needs a promotion piece. Append `q`, `r`, `b`, or `n` to the UCI, e.g. `e7e8q`.

**PGN (AT game records):** the lexicon's `pgn` field holds the mainline from the standard start. Moves inside the engine stay UCI; `pgn.js` only converts. `appendMove` always writes the same canonical style, `1. e4 e5 2. Nf3` (no tags, no result token, single spaces), so two clients that played the same moves write identical text. `replayPGN` also reads tags, `{comments}`, `; comments`, `$1` annotations and a final result token, but rejects variations, since records hold the mainline only.

```js
let { pgn, state } = appendMove('', 'e2e4').value;  // pgn: '1. e4'
const result = replayPGN(record.pgn);                  // validate an opponent's record
if (!result.ok) reject(result.error);                  // e.g. 'Move 12 (Nxe9): Illegal or unknown move: Nxe9'

// When an opponent's record changes, accept exactly one new move, made by them:
const update = nextMove(lastAcceptedPgn, record.pgn);
if (update.ok) {
  if (update.value.color !== opponentColor) reject('Not their move');
} else if (update.code !== 'NO_NEW_MOVE') {            // NO_NEW_MOVE: e.g. only tags changed, ignore
  reject(update.error);                                // e.g. CHANGED_MOVE: 'Move 3 was changed or removed'
}
```

Always check updates with `nextMove`, not just `replayPGN`: game records can be edited, so a valid PGN could still have rewritten an earlier move.

**Chessground destinations:** group `legalMoves(state)` by the first two characters, e.g. `"e2e4"` → `dests.get("e2").push("e4")`.
