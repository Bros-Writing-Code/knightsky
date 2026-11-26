// @ts-check
/**
 * pgn.js — Standard Algebraic Notation (SAN) and PGN move text.
 *
 * The AT lexicon stores each game as PGN (app.knightsky.game `pgn`): the full
 * mainline from the standard starting position. Inside the engine every move
 * is still UCI; this file only converts between UCI and SAN, and between a
 * list of moves and PGN text.
 *
 * Every function here is pure. Untrusted text (a PGN from the network, a SAN
 * typed by a user) returns a Result instead of throwing.
 */

import { fromSquare, rowOf, SQUARES, sqIndex, sqName, toSquare } from './0x88helper.js';
import { createGame } from './game.js';
import { applyMove, isInCheck } from './gameState.js';
import { moveGenerator } from './moveGeneration.js';

/** @typedef {import('./types.js').GameState} GameState */
/**
 * @template T
 * @typedef {import('./types.js').Result<T>} Result
 */

const RESULT_TOKENS = new Set(['1-0', '0-1', '1/2-1/2', '*']);
/** Results that end the game; "*" means it is still going. */
const FINAL_RESULTS = new Set(['1-0', '0-1', '1/2-1/2']);

/* ─────────────────────────── UCI → SAN ─────────────────────────── */

/**
 * The part of a SAN move before any check mark, e.g. "Nbd2", "exd6", "e8=Q".
 * `legal` holds the legal moves that matter for this move: those of the same
 * piece type to the same square (see movesTo). Every other move is irrelevant.
 *
 * @param {GameState} state
 * @param {string} uci - A legal move.
 * @param {string[]} legal - Every legal move in this position.
 * @returns {string}
 */
function sanBody(state, uci, legal) {
  const from = sqIndex(uci.slice(0, 2));
  const to = sqIndex(uci.slice(2, 4));
  const piece = /** @type {import('./types.js').Piece} */ (state.board[from]);
  const target = uci.slice(2, 4);

  if (piece.type === 'k' && Math.abs((to & 7) - (from & 7)) === 2) {
    return (to & 7) === 6 ? 'O-O' : 'O-O-O';
  }

  if (piece.type === 'p') {
    const capture = (from & 7) !== (to & 7) ? `${uci[0]}x` : '';
    const promotion = uci.length === 5 ? `=${uci[4].toUpperCase()}` : '';
    return capture + target + promotion;
  }

  const capture = state.board[to] ? 'x' : '';
  return piece.type.toUpperCase() + disambiguation(state, uci, legal) + capture + target;
}

/**
 * The file and/or rank needed when another piece of the same type can also
 * reach the target square: "" (none), "b" (file), "1" (rank) or "b1" (both).
 *
 * @param {GameState} state
 * @param {string} uci
 * @param {string[]} legal
 * @returns {string}
 */
function disambiguation(state, uci, legal) {
  const origin = uci.slice(0, 2);
  const type = state.board[sqIndex(origin)]?.type;
  const rivals = legal
    .filter((other) => other.slice(2, 4) === uci.slice(2, 4) && other.slice(0, 2) !== origin)
    .map((other) => other.slice(0, 2))
    .filter((square) => state.board[sqIndex(square)]?.type === type);

  if (rivals.length === 0) {
    return '';
  }
  if (rivals.every((square) => square[0] !== origin[0])) {
    return origin[0];
  }
  if (rivals.every((square) => square[1] !== origin[1])) {
    return origin[1];
  }
  return origin;
}

/**
 * Legal UCI moves of one piece type to one square, for the side to move.
 * Writing or reading a SAN move only needs these (for disambiguation), so
 * this skips generating every legal move in the position.
 *
 * @param {GameState} state
 * @param {string} type - Piece type: "p", "n", "b", "r", "q" or "k".
 * @param {string} target - Square name, e.g. "d2".
 * @returns {string[]}
 */
function movesTo(state, type, target) {
  const to = sqIndex(target);
  const moves = [];
  for (const index of SQUARES) {
    const piece = state.board[index];
    if (piece?.color !== state.currentTurn || piece.type !== type) {
      continue;
    }
    if (!moveGenerator(state, toSquare(index)).some((square) => fromSquare(square) === to)) {
      continue;
    }
    const uci = sqName(index) + target;
    const promotes = type === 'p' && rowOf(to) === (piece.color === 'w' ? 0 : 7);
    moves.push(...(promotes ? ['q', 'r', 'b', 'n'].map((p) => uci + p) : [uci]));
  }
  return moves;
}

/**
 * Converts a legal UCI move into SAN, including "+" for check and "#" for
 * checkmate.
 *
 * @param {GameState} state - Position before the move.
 * @param {string} uci - e.g. "g1f3", "e7e8q", "e1g1".
 * @returns {string} e.g. "Nf3", "e8=Q+", "O-O".
 * @throws {Error} If the move is malformed or illegal (check with isValidMove first).
 * @example toSAN(createGame(), 'g1f3') // "Nf3"
 */
export function toSAN(state, uci) {
  const result = applyMove(state, uci);
  if (!result.ok) {
    throw new Error(`Cannot write ${uci} as SAN: ${result.error}`);
  }
  const type = /** @type {import('./types.js').Piece} */ (state.board[sqIndex(uci.slice(0, 2))])
    .type;
  return sanBody(state, uci, movesTo(state, type, uci.slice(2, 4))) + checkMark(result.value);
}

/**
 * "#" if the side to move is checkmated, "+" if it is in check, else "".
 * @param {GameState} after - Position after the move.
 * @returns {string}
 */
function checkMark(after) {
  if (after.status === 'checkmate') {
    return '#';
  }
  return isInCheck(after) ? '+' : '';
}

/* ─────────────────────────── SAN → UCI ─────────────────────────── */

/**
 * Normalizes accepted SAN variants: drops check marks and annotations
 * ("+", "#", "!", "?"), reads "0-0" as "O-O", and adds a missing "=" to
 * promotions ("e8Q" → "e8=Q").
 *
 * @param {string} san
 * @returns {string}
 */
function normalizeSAN(san) {
  return san
    .trim()
    .replace(/[+#!?]+$/, '')
    .replace(/^0-0(-0)?$/, (castle) => castle.replaceAll('0', 'O'))
    .replace(/^([a-h](?:x[a-h])?[18])=?([qrbnQRBN])$/, (_, move, piece) => {
      return `${move}=${piece.toUpperCase()}`;
    });
}

/**
 * The moving piece's type and the target square named by a normalized SAN
 * move, or null if it isn't SAN at all.
 *
 * @param {GameState} state
 * @param {string} wanted - Output of normalizeSAN.
 * @returns {{ type: string, target: string } | null}
 */
function sanTarget(state, wanted) {
  if (wanted === 'O-O' || wanted === 'O-O-O') {
    const rank = state.currentTurn === 'w' ? '1' : '8';
    return { type: 'k', target: (wanted === 'O-O' ? 'g' : 'c') + rank };
  }
  const match = /^([NBRQK])?[a-h1-8x]*?([a-h][1-8])(=[QRBN])?$/.exec(wanted);
  return match ? { type: (match[1] ?? 'P').toLowerCase(), target: match[2] } : null;
}

/**
 * Finds the one legal move a SAN string names.
 * Returns the UCI move and its canonical SAN body (without check marks).
 *
 * @param {GameState} state
 * @param {string} san
 * @returns {Result<{ uci: string, body: string }>}
 */
function matchSAN(state, san) {
  if (typeof san !== 'string' || san.trim() === '') {
    return { ok: false, error: 'SAN move must be a non-empty string' };
  }
  if (state.status !== 'active') {
    return { ok: false, error: 'The game is already over' };
  }

  const wanted = normalizeSAN(san);
  const named = sanTarget(state, wanted);
  const candidates = named ? movesTo(state, named.type, named.target) : [];
  const matches = candidates.filter((uci) => sanBody(state, uci, candidates) === wanted);

  if (matches.length === 1) {
    return { ok: true, value: { uci: matches[0], body: wanted } };
  }
  if (matches.length > 1) {
    return { ok: false, error: `Ambiguous move: ${san}` };
  }
  return { ok: false, error: `Illegal or unknown move: ${san}` };
}

/**
 * Converts a SAN move into UCI for the given position. Check marks are
 * accepted but not required, and their accuracy is not checked.
 *
 * @param {GameState} state - Position before the move.
 * @param {string} san - e.g. "Nf3", "exd6", "O-O", "e8=Q+".
 * @returns {Result<string>} The UCI move, e.g. { ok: true, value: "g1f3" }.
 * @example fromSAN(createGame(), 'Nf3') // { ok: true, value: 'g1f3' }
 */
export function fromSAN(state, san) {
  const match = matchSAN(state, san);
  return match.ok ? { ok: true, value: match.value.uci } : match;
}

/* ─────────────────────────── PGN text ─────────────────────────── */

/**
 * Removes comments ({...} and ; to end of line) and tag pairs ([Name "value"])
 * in one pass. Brackets inside them mean nothing, so {note (text)} and
 * [Event "Open (Round 2)"] are fine; parentheses anywhere else start a
 * variation, which records never contain (the lexicon stores the mainline only).
 *
 * @param {string} pgn
 * @returns {Result<string>} The move text, with comments and tags replaced by spaces.
 */
function moveText(pgn) {
  let text = '';
  let closer = null; // '}', '\n' or ']' while inside a comment or tag
  let quoted = false; // inside a tag's "value", where ']' doesn't end the tag
  let escaped = false;
  for (const char of pgn) {
    if (closer === ']' && (quoted || char === '"')) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quoted = !quoted;
      }
    } else if (closer) {
      if (char === closer) {
        closer = null;
        text += ' ';
      }
    } else if (char === '{' || char === ';' || char === '[') {
      closer = { '{': '}', ';': '\n', '[': ']' }[char];
    } else if (char === '(' || char === ')') {
      return { ok: false, error: 'Variations are not supported; send the mainline only' };
    } else {
      text += char;
    }
  }
  if (closer === '}') {
    return { ok: false, error: 'Unclosed comment' };
  }
  if (closer === ']') {
    return { ok: false, error: 'Unclosed tag' };
  }
  return { ok: true, value: text };
}

/**
 * Splits PGN text into move tokens. Skips tag pairs, comments, NAGs ($1) and
 * move numbers ("1.", "1...", including "1.e4"). A result token (1-0, 0-1,
 * 1/2-1/2, *) may only come last, and is returned separately.
 *
 * @param {string} pgn
 * @returns {Result<{ moves: string[], result: string | null }>}
 */
function tokenizePGN(pgn) {
  const text = moveText(pgn);
  if (!text.ok) {
    return text;
  }

  const tokens = [];
  for (const raw of text.value.split(/\s+/)) {
    const token = raw.replace(/^\d+\.+/, '');
    if (token !== '' && !/^\$\d+$/.test(token)) {
      tokens.push(token);
    }
  }

  const resultAt = tokens.findIndex((token) => RESULT_TOKENS.has(token));
  if (resultAt !== -1 && resultAt !== tokens.length - 1) {
    return { ok: false, error: `Moves found after the result ${tokens[resultAt]}` };
  }
  return resultAt === -1
    ? { ok: true, value: { moves: tokens, result: null } }
    : { ok: true, value: { moves: tokens.slice(0, -1), result: tokens[resultAt] } };
}

/**
 * Replays PGN text from the standard starting position.
 * Returns the final state, every move as SAN in canonical form, and the
 * result token if there is one ("1-0", "0-1", "1/2-1/2", "*" or null).
 *
 * @param {unknown} pgn
 * @returns {Result<{ state: GameState, sans: string[], ucis: string[], result: string | null }>}
 */
function parsePGN(pgn) {
  if (typeof pgn !== 'string') {
    return { ok: false, error: 'PGN must be a string' };
  }
  const tokens = tokenizePGN(pgn);
  if (!tokens.ok) {
    return tokens;
  }

  let state = createGame();
  const sans = [];
  const ucis = [];
  const { moves, result: gameResult } = tokens.value;
  for (let i = 0; i < moves.length; i++) {
    const token = moves[i];
    const match = matchSAN(state, token);
    const result = match.ok ? applyMove(state, match.value.uci) : match;
    if (!result.ok) {
      return { ok: false, error: `Move ${i + 1} (${token}): ${result.error}` };
    }
    // Canonical SAN, whatever the input style: the matched body plus our own check mark.
    sans.push(match.value.body + checkMark(result.value));
    ucis.push(match.value.uci);
    state = result.value;
  }
  return { ok: true, value: { state, sans, ucis, result: gameResult } };
}

/**
 * An error if the PGN ends with a final result (1-0, 0-1, 1/2-1/2), e.g. after
 * a resignation or an agreed draw, since no move may follow it. Checkmate and
 * stalemate are already caught by applyMove.
 *
 * @param {string | null} result
 * @returns {Result<null>}
 */
function checkNotFinished(result) {
  return result !== null && FINAL_RESULTS.has(result)
    ? { ok: false, error: `The game is already over (${result})` }
    : { ok: true, value: null };
}

/**
 * Writes SAN moves as PGN move text: "1. e4 e5 2. Nf3". No tag pairs and no
 * result token, so two clients that played the same moves write the same text.
 *
 * @param {string[]} sans
 * @returns {string}
 */
function formatPGN(sans) {
  return sans.map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san)).join(' ');
}

/**
 * Rebuilds a game from PGN text, e.g. the `pgn` field of an AT game record.
 * Starts from the standard position and stops at the first illegal move.
 * An empty string is a game with no moves yet.
 *
 * @param {string} pgn - e.g. "1. e4 e5 2. Nf3 Nc6".
 * @returns {Result<GameState>} The error names the failing move, e.g.
 *   "Move 3 (Nf6): Illegal or unknown move: Nf6".
 * @example replayPGN('1. e4 e5') // { ok: true, value: GameState }
 */
export function replayPGN(pgn) {
  const parsed = parsePGN(pgn);
  return parsed.ok ? { ok: true, value: parsed.value.state } : parsed;
}

/**
 * Adds one move to a PGN game and returns the new PGN text with the new
 * position. The whole PGN is checked first, and the output is always in
 * canonical form ("1. e4 e5 2. Nf3"), so comments and tags are dropped.
 * A PGN that ends with a final result (1-0, 0-1, 1/2-1/2) takes no more moves.
 *
 * @param {string} pgn - The game so far ("" before the first move).
 * @param {string} uci - The move to add, e.g. "g1f3".
 * @returns {Result<{ pgn: string, state: GameState }>}
 * @example appendMove('1. e4 e5', 'g1f3') // { ok: true, value: { pgn: '1. e4 e5 2. Nf3', state } }
 */
export function appendMove(pgn, uci) {
  const parsed = parsePGN(pgn);
  if (!parsed.ok) {
    return parsed;
  }

  const finished = checkNotFinished(parsed.value.result);
  if (!finished.ok) {
    return finished;
  }

  const { state, sans } = parsed.value;
  const result = applyMove(state, uci);
  if (!result.ok) {
    return { ok: false, error: `${uci}: ${result.error}` };
  }

  const nextPGN = formatPGN([...sans, toSAN(state, uci)]);
  return { ok: true, value: { pgn: nextPGN, state: result.value } };
}

/**
 * Why nextMove rejected an update. `error` stays a readable message; `code` is
 * stable, so callers can branch on it:
 * - INVALID_PREVIOUS: the previous PGN doesn't parse (a bug on our side).
 * - GAME_OVER: the previous game already ended (checkmate, stalemate, a draw,
 *   or a final result 1-0 / 0-1 / 1/2-1/2), even if the update drops the result.
 * - INVALID_PGN: the new PGN doesn't parse or contains an illegal move.
 * - CHANGED_MOVE: an earlier move was rewritten or removed.
 * - NO_NEW_MOVE: same moves as before (e.g. only tags or comments changed).
 * - TOO_MANY_MOVES: more than one move was added.
 *
 * @typedef {'INVALID_PREVIOUS' | 'GAME_OVER' | 'INVALID_PGN' | 'CHANGED_MOVE' | 'NO_NEW_MOVE' | 'TOO_MANY_MOVES'} NextMoveCode
 */

/**
 * Checks that an updated PGN is the previous one plus exactly one legal move,
 * and returns that move. Use it whenever an opponent's game record changes:
 * it rejects rewritten or removed earlier moves, updates with no new move,
 * several moves at once, and any move after the game ended. Moves are
 * compared, not text, so tags, comments and spacing don't matter.
 *
 * @param {string} oldPgn - The game as last accepted ("" before the first move).
 * @param {string} newPgn - The updated record.
 * @returns {{ ok: true, value: { uci: string, san: string, color: 'w' | 'b', state: GameState } }
 *   | { ok: false, error: string, code: NextMoveCode }}
 *   `color` is the side that made the move, so callers can check it was that
 *   player's turn; `state` is the position after it. On failure, `code` says
 *   why (see NextMoveCode) and `error` is a message for logs or display.
 * @example nextMove('1. e4', '1. e4 e5') // { ok: true, value: { uci: 'e7e5', san: 'e5', color: 'b', state } }
 * @example nextMove('1. e4', '1. d4') // { ok: false, error: 'Move 1 was changed or removed', code: 'CHANGED_MOVE' }
 */
export function nextMove(oldPgn, newPgn) {
  const before = parsePGN(oldPgn);
  if (!before.ok) {
    return { ok: false, error: `Previous PGN: ${before.error}`, code: 'INVALID_PREVIOUS' };
  }
  const finished = checkNotFinished(before.value.result);
  if (!finished.ok) {
    return { ...finished, code: 'GAME_OVER' };
  }
  if (before.value.state.status !== 'active') {
    return { ok: false, error: 'The game is already over', code: 'GAME_OVER' };
  }
  const after = parsePGN(newPgn);
  if (!after.ok) {
    return { ...after, code: 'INVALID_PGN' };
  }

  const previous = before.value.sans;
  const updated = after.value.sans;
  const changed = previous.findIndex((san, i) => updated[i] !== san);
  if (changed !== -1) {
    return { ok: false, error: `Move ${changed + 1} was changed or removed`, code: 'CHANGED_MOVE' };
  }

  const added = updated.length - previous.length;
  if (added !== 1) {
    return added === 0
      ? { ok: false, error: 'No new move', code: 'NO_NEW_MOVE' }
      : { ok: false, error: `Expected one new move, found ${added}`, code: 'TOO_MANY_MOVES' };
  }

  return {
    ok: true,
    value: {
      uci: /** @type {string} */ (after.value.ucis.at(-1)),
      san: /** @type {string} */ (updated.at(-1)),
      color: before.value.state.currentTurn,
      state: after.value.state,
    },
  };
}
