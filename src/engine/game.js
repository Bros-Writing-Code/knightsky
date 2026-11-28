// @ts-check
/**
 * game.js — small pure helpers for starting, reading, and replaying games.
 *
 * Every function here is pure: it never mutates its input and never stores
 * a game. The caller owns all GameState objects.
 */

import { SQUARES, toIndex, toSquare } from './0x88helper.js';
import { applyMove, checkMove, getGameStatus } from './gameState.js';
import { moveGenerator } from './moveGeneration.js';
import { FENtoGameState, moveToUCI } from './notation.js';

/** @typedef {import('./types.js').GameState} GameState */
/** @typedef {import('./types.js').Piece} Piece */
/** @typedef {import('./types.js').Square} Square */
/**
 * @template T
 * @typedef {import('./types.js').Result<T>} Result
 */

/** FEN of the standard starting position. */
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * Creates a new game. Returns a fresh object on every call, so two games
 * never share a board. The status already reflects the position, so a
 * checkmate or stalemate FEN starts as finished.
 *
 * @param {string} [fen=START_FEN] - Starting position.
 * @returns {GameState}
 * @throws {Error} If the FEN is malformed or a side doesn't have exactly one king
 *   (use replayMoves for untrusted input).
 * @example const state = createGame();
 */
export function createGame(fen = START_FEN) {
  const state = FENtoGameState(fen);
  assertOneKingEach(state);
  // States share piece objects (see applyMove), so freeze them: changing a piece
  // in any state throws instead of silently changing older states too.
  for (const piece of state.board) {
    if (piece) {
      Object.freeze(piece);
    }
  }
  return { ...state, ...getGameStatus(state) };
}

/**
 * Checked once when a game is created, so applyMove doesn't recheck it on
 * every move. Without both kings, check and checkmate have no meaning.
 *
 * @param {GameState} state
 * @throws {Error} Unless each side has exactly one king.
 */
function assertOneKingEach(state) {
  const kings = SQUARES.map((index) => state.board[index]).filter((piece) => piece?.type === 'k');
  const white = kings.filter((king) => king?.color === 'w').length;
  if (kings.length !== 2 || white !== 1) {
    throw new Error('Invalid position: each side needs exactly one king');
  }
}

/**
 * True if `square` is a {row, col} object with both values in 0-7.
 * @param {unknown} square
 * @returns {square is Square}
 */
function isValidSquare(square) {
  const s = /** @type {any} */ (square);
  return (
    !!s &&
    Number.isInteger(s.row) &&
    s.row >= 0 &&
    s.row <= 7 &&
    Number.isInteger(s.col) &&
    s.col >= 0 &&
    s.col <= 7
  );
}

/**
 * Returns a copy of the piece on a square, or null if it is empty.
 * It is a copy, so changing it never changes the game state.
 *
 * @param {GameState} state
 * @param {Square} square - {row, col}, row 0 = rank 8, col 0 = file a.
 * @returns {Piece|null}
 * @throws {Error} If the square is outside the board.
 * @example getPiece(createGame(), { row: 7, col: 4 }) // { color: 'w', type: 'k' }
 */
export function getPiece(state, square) {
  if (!isValidSquare(square)) {
    throw new Error(`Invalid square: ${JSON.stringify(square)}`);
  }
  const piece = state.board[toIndex(square.row, square.col)];
  return piece ? { ...piece } : null;
}

/**
 * Returns the board as an 8x8 array for rendering: grid[row][col], with
 * row 0 = rank 8 (Black's back rank) and col 0 = file a.
 * The grid and its pieces are copies; changing them does not change the state.
 *
 * @param {GameState} state
 * @returns {Array<Array<Piece|null>>}
 * @example toGrid(createGame())[7][4] // { color: 'w', type: 'k' } (e1)
 */
export function toGrid(state) {
  const grid = [];
  for (let row = 0; row < 8; row++) {
    const cells = [];
    for (let col = 0; col < 8; col++) {
      const piece = state.board[toIndex(row, col)];
      cells.push(piece ? { ...piece } : null);
    }
    grid.push(cells);
  }
  return grid;
}

/**
 * Legal destinations for the piece on `square`, for highlighting.
 * Returns [] once the game is over, matching legalMoves and isValidMove.
 *
 * @param {GameState} state
 * @param {Square} square - {row, col} of the selected piece.
 * @returns {Square[]}
 * @example legalMovesFrom(createGame(), { row: 6, col: 4 }) // e2 → e3, e4
 */
export function legalMovesFrom(state, square) {
  if (state.status !== 'active') {
    return [];
  }
  return moveGenerator(state, square);
}

/**
 * Returns every legal move for the side to move, as UCI strings.
 * Promotions appear once per piece choice (e.g. "a7a8q", "a7a8r", ...).
 * Useful for building a board library's destination map, or for bots.
 *
 * @param {GameState} state
 * @returns {string[]}
 * @example legalMoves(createGame()).length // 20
 */
export function legalMoves(state) {
  if (state.status !== 'active') {
    return [];
  }

  /** @type {string[]} */
  const moves = [];
  for (const index of SQUARES) {
    const piece = state.board[index];
    if (!piece || piece.color !== state.currentTurn) {
      continue;
    }

    const from = toSquare(index);
    const lastRow = piece.color === 'w' ? 0 : 7;
    for (const to of moveGenerator(state, from)) {
      const uci = moveToUCI({ from, to });
      if (piece.type === 'p' && to.row === lastRow) {
        for (const promotion of ['q', 'r', 'b', 'n']) {
          moves.push(uci + promotion);
        }
      } else {
        moves.push(uci);
      }
    }
  }
  return moves;
}

/**
 * True if `uci` is a legal move for the side to move.
 * Never throws; malformed input simply returns false.
 *
 * @param {GameState} state
 * @param {string} uci - e.g. "e2e4", "e7e8q".
 * @returns {boolean}
 */
export function isValidMove(state, uci) {
  // Only the legality check: no new state, histories or game status.
  return checkMove(state, uci).ok;
}

/**
 * Rebuilds a game by replaying UCI moves in order, e.g. after a page refresh.
 * Stops at the first move that is malformed or illegal.
 *
 * @param {string[]} ucis - Moves in play order (sorted by ply).
 * @param {string} [startFen=START_FEN] - Position the moves start from.
 * @returns {Result<GameState>}
 * @example replayMoves(['e2e4', 'e7e5']) // { ok: true, value: GameState }
 */
export function replayMoves(ucis, startFen = START_FEN) {
  if (!Array.isArray(ucis)) {
    return { ok: false, error: 'Moves must be an array of UCI strings.' };
  }

  /** @type {GameState} */
  let state;
  try {
    state = createGame(startFen);
  } catch (e) {
    return { ok: false, error: `Invalid start position: ${/** @type {Error} */ (e).message}` };
  }

  for (let i = 0; i < ucis.length; i++) {
    const result = applyMove(state, ucis[i]);
    if (!result.ok) {
      return { ok: false, error: `Move ${i + 1} (${ucis[i]}): ${result.error}` };
    }
    state = result.value;
  }

  return { ok: true, value: state };
}

/** Material value of each piece type; kings aren't counted. */
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };

/**
 * The material on the board now: each side's pieces (kings excluded), the
 * pieces each side has more of than the other, and the point difference.
 * For a material display like lichess's: show `ahead.white` and `ahead.black`
 * beside each player, with `difference` as "+N" for the side that is ahead.
 *
 * This describes the current board only, not which pieces were captured: the
 * starting set minus these counts is wrong after a promotion (one fewer pawn,
 * one more queen, yet nothing was captured). `ahead` stays correct then.
 *
 * @param {GameState} state
 * @returns {{
 *   white: Record<'p'|'n'|'b'|'r'|'q', number>,
 *   black: Record<'p'|'n'|'b'|'r'|'q', number>,
 *   ahead: { white: Record<'p'|'n'|'b'|'r'|'q', number>, black: Record<'p'|'n'|'b'|'r'|'q', number> },
 *   difference: number,
 * }}
 *   `ahead.white.q` is how many more queens White has than Black (0 if not more).
 *   `difference` is White's material minus Black's (pawn 1, knight/bishop 3, rook 5, queen 9).
 * @example materialCount(createGame()) // { white: { p: 8, n: 2, b: 2, r: 2, q: 1 }, black: { ... }, ahead: { white: { p: 0, ... }, black: { ... } }, difference: 0 }
 */
export function materialCount(state) {
  const counts = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const index of SQUARES) {
    const piece = state.board[index];
    if (piece && piece.type !== 'k') {
      counts[piece.color][piece.type]++;
    }
  }
  const value = (side) =>
    Object.entries(side).reduce((sum, [type, count]) => sum + count * PIECE_VALUES[type], 0);
  const more = (side, other) =>
    /** @type {Record<'p'|'n'|'b'|'r'|'q', number>} */ (
      Object.fromEntries(
        Object.entries(side).map(([type, count]) => [type, Math.max(0, count - other[type])]),
      )
    );
  return {
    white: counts.w,
    black: counts.b,
    ahead: { white: more(counts.w, counts.b), black: more(counts.b, counts.w) },
    difference: value(counts.w) - value(counts.b),
  };
}
