import { Chess } from 'chess.js';
import { describe, it, expect } from 'vitest';
import {
  START_FEN,
  appendMove,
  applyMove,
  createGame,
  fromSAN,
  GameStatetoFEN,
  legalMoves,
  nextMove,
  replayPGN,
  toSAN,
} from '../index.js';

/** Apply moves that must all be legal; fails the test otherwise. */
function play(state, ...ucis) {
  for (const uci of ucis) {
    const result = applyMove(state, uci);
    expect(result, `${uci}: ${result.error}`).toMatchObject({ ok: true });
    state = result.value;
  }
  return state;
}

/** First three FEN fields (board, side to move, castling). */
const corePosition = (fen) => fen.split(' ').slice(0, 3).join(' ');

describe('toSAN', () => {
  it('writes pawn moves, piece moves and captures', () => {
    const start = createGame();
    expect(toSAN(start, 'e2e4')).toBe('e4');
    expect(toSAN(start, 'g1f3')).toBe('Nf3');

    const open = play(start, 'e2e4', 'd7d5');
    expect(toSAN(open, 'e4d5')).toBe('exd5');

    const knights = play(start, 'e2e4', 'e7e5', 'g1f3', 'd7d6');
    expect(toSAN(knights, 'f3e5')).toBe('Nxe5');
  });

  it('writes en passant as a pawn capture', () => {
    const state = play(createGame(), 'e2e4', 'a7a6', 'e4e5', 'd7d5');
    expect(toSAN(state, 'e5d6')).toBe('exd6');
  });

  it('writes castling on both sides', () => {
    const state = createGame('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(toSAN(state, 'e1g1')).toBe('O-O');
    expect(toSAN(state, 'e1c1')).toBe('O-O-O');
  });

  it('writes promotions, with capture and check', () => {
    const quiet = createGame('8/P6k/8/8/8/8/8/K7 w - - 0 1');
    expect(toSAN(quiet, 'a7a8q')).toBe('a8=Q');
    expect(toSAN(quiet, 'a7a8n')).toBe('a8=N');

    const capture = createGame('1n5k/P7/8/8/8/8/8/K7 w - - 0 1');
    expect(toSAN(capture, 'a7b8q')).toBe('axb8=Q+');
  });

  it('adds + for check and # for checkmate', () => {
    const check = play(createGame(), 'e2e4', 'f7f5');
    expect(toSAN(check, 'd1h5')).toBe('Qh5+');

    const mate = play(createGame(), 'f2f3', 'e7e5', 'g2g4');
    expect(toSAN(mate, 'd8h4')).toBe('Qh4#');
  });

  it('adds the file, the rank, or both when two pieces can reach the square', () => {
    const byFile = createGame('4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1');
    expect(toSAN(byFile, 'b1d2')).toBe('Nbd2');
    expect(toSAN(byFile, 'f1d2')).toBe('Nfd2');

    const byRank = createGame('4k3/8/8/R7/8/8/8/R3K3 w - - 0 1');
    expect(toSAN(byRank, 'a1a3')).toBe('R1a3');
    expect(toSAN(byRank, 'a5a3')).toBe('R5a3');

    const both = createGame('8/7k/8/2Q5/8/2Q1Q3/8/7K w - - 0 1');
    expect(toSAN(both, 'c3d4')).toBe('Qc3d4');
    expect(toSAN(both, 'e3d4')).toBe('Qed4');
    expect(toSAN(both, 'c5d4')).toBe('Q5d4');
  });

  it('does not disambiguate against a pinned piece', () => {
    // The c3 knight is pinned by the a5 bishop, so only the g1 knight can go to e2.
    const state = createGame('4k3/8/8/b7/8/2N5/8/4K1N1 w - - 0 1');
    expect(toSAN(state, 'g1e2')).toBe('Ne2');
  });

  it('throws on a malformed or illegal move', () => {
    expect(() => toSAN(createGame(), 'e2e5')).toThrow(/Illegal move/);
    expect(() => toSAN(createGame(), 'hello')).toThrow(/Malformed/);
  });
});

describe('fromSAN', () => {
  it('reads SAN into UCI', () => {
    const start = createGame();
    expect(fromSAN(start, 'Nf3')).toEqual({ ok: true, value: 'g1f3' });
    expect(fromSAN(start, 'e4')).toEqual({ ok: true, value: 'e2e4' });

    const castling = createGame('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(fromSAN(castling, 'O-O-O')).toEqual({ ok: true, value: 'e1c1' });

    const byFile = createGame('4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1');
    expect(fromSAN(byFile, 'Nfd2')).toEqual({ ok: true, value: 'f1d2' });
  });

  it('accepts common variants: check marks, annotations, 0-0, promotion without =', () => {
    const start = createGame();
    expect(fromSAN(start, 'Nf3!?').value).toBe('g1f3');

    const check = play(createGame(), 'e2e4', 'f7f5');
    expect(fromSAN(check, 'Qh5')).toEqual({ ok: true, value: 'd1h5' });
    expect(fromSAN(check, 'Qh5+')).toEqual({ ok: true, value: 'd1h5' });

    const castling = createGame('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(fromSAN(castling, '0-0')).toEqual({ ok: true, value: 'e1g1' });

    const promotion = createGame('8/P6k/8/8/8/8/8/K7 w - - 0 1');
    expect(fromSAN(promotion, 'a8Q').value).toBe('a7a8q');
    expect(fromSAN(promotion, 'a8=n').value).toBe('a7a8n');
  });

  it('returns an error for illegal, missing-disambiguation or malformed SAN', () => {
    const start = createGame();
    expect(fromSAN(start, 'Nf6')).toMatchObject({ ok: false, error: /Illegal or unknown/ });
    expect(fromSAN(start, 'e5')).toMatchObject({ ok: false });
    expect(fromSAN(start, '')).toMatchObject({ ok: false, error: /non-empty string/ });
    expect(fromSAN(start, /** @type {any} */ (42))).toMatchObject({ ok: false });

    const byFile = createGame('4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1');
    expect(fromSAN(byFile, 'Nd2')).toMatchObject({ ok: false });
  });
});

describe('replayPGN', () => {
  it('treats an empty PGN as a game with no moves', () => {
    for (const empty of ['', '   ']) {
      const result = replayPGN(empty);
      expect(result.ok).toBe(true);
      expect(GameStatetoFEN(result.value)).toBe(START_FEN);
    }
  });

  it('replays a game and reports its status', () => {
    const result = replayPGN('1. f3 e5 2. g4 Qh4#');
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ status: 'checkmate', winner: 'b' });
  });

  it('skips tags, comments, annotations, move numbers and the result', () => {
    const pgn =
      '[Event "Test"]\n[White "A"]\n\n1.e4 {best by test} e5 $1 2. Nf3 ; a comment\n2... Nc6 *';
    const result = replayPGN(pgn);
    expect(result.ok).toBe(true);
    expect(GameStatetoFEN(result.value)).toBe(
      'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
    );
  });

  it('ignores parentheses and brackets inside comments and tags', () => {
    const afterNf3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
    const pgns = [
      '1. e4 {note (text)} e5 2. Nf3',
      '[Event "Open (Round 2)"]\n1. e4 e5 2. Nf3',
      '[Event "a]b \\"quoted\\" (x)"] 1. e4 e5 2. Nf3',
      '1. e4 ; a (b) {c [d\ne5 2. Nf3',
      '1. e4 {see [this] and ; that} e5 2. Nf3',
    ];
    for (const pgn of pgns) {
      const result = replayPGN(pgn);
      expect(result.ok, `${pgn}: ${result.error}`).toBe(true);
      expect(GameStatetoFEN(result.value)).toBe(afterNf3);
    }
  });

  it('names the first illegal move', () => {
    expect(replayPGN('1. e4 e5 2. Nf6 Nc6')).toEqual({
      ok: false,
      error: 'Move 3 (Nf6): Illegal or unknown move: Nf6',
    });
  });

  it('rejects variations, unclosed comments, moves after the result, and non-strings', () => {
    expect(replayPGN('1. e4 (1. d4) e5')).toMatchObject({ ok: false, error: /Variations/ });
    expect(replayPGN('1. e4 {oops e5')).toMatchObject({ ok: false, error: /Unclosed comment/ });
    expect(replayPGN('1. e4 e5) 2. Nf3')).toMatchObject({ ok: false, error: /Variations/ });
    expect(replayPGN('[Event "x" 1. e4')).toMatchObject({ ok: false, error: /Unclosed tag/ });
    expect(replayPGN('1. e4 1-0 e5')).toMatchObject({ ok: false, error: /after the result/ });
    expect(replayPGN(/** @type {any} */ (null))).toMatchObject({ ok: false });
  });

  it('rejects moves after checkmate', () => {
    expect(replayPGN('1. f3 e5 2. g4 Qh4# 3. a3')).toMatchObject({
      ok: false,
      error: /Move 5 \(a3\)/,
    });
  });
});

describe('appendMove', () => {
  it('builds the PGN one move at a time', () => {
    let pgn = '';
    for (const uci of ['e2e4', 'e7e5', 'g1f3']) {
      const result = appendMove(pgn, uci);
      expect(result.ok).toBe(true);
      pgn = result.value.pgn;
    }
    expect(pgn).toBe('1. e4 e5 2. Nf3');
  });

  it('returns the new state, matching a replay of the new PGN', () => {
    const result = appendMove('1. f3 e5 2. g4', 'd8h4');
    expect(result.ok).toBe(true);
    expect(result.value.pgn).toBe('1. f3 e5 2. g4 Qh4#');
    expect(result.value.state.status).toBe('checkmate');
    expect(GameStatetoFEN(result.value.state)).toBe(
      GameStatetoFEN(/** @type {any} */ (replayPGN(result.value.pgn)).value),
    );
  });

  it('writes canonical PGN even when the input has tags and comments', () => {
    const result = appendMove('[Event "x"] 1.e4 {hi} e5', 'g1f3');
    expect(result.value?.pgn).toBe('1. e4 e5 2. Nf3');
  });

  it('returns an error for an illegal move, a bad PGN, or a finished game', () => {
    expect(appendMove('1. e4', 'e2e4')).toMatchObject({ ok: false, error: /^e2e4: / });
    expect(appendMove('1. e4 e5 2. Nf6', 'b8c6')).toMatchObject({ ok: false, error: /Move 3/ });
    expect(appendMove('1. f3 e5 2. g4 Qh4#', 'a2a3')).toMatchObject({
      ok: false,
      error: /already over/,
    });
  });

  it('refuses a move after a final result (resignation or agreed draw), but not after *', () => {
    for (const result of ['1-0', '0-1', '1/2-1/2']) {
      expect(appendMove(`1. e4 ${result}`, 'e7e5')).toEqual({
        ok: false,
        error: `The game is already over (${result})`,
      });
    }
    expect(appendMove('1. e4 *', 'e7e5')).toMatchObject({ ok: true, value: { pgn: '1. e4 e5' } });
  });
});

describe('nextMove', () => {
  it('returns the one new move, who made it, and the new position', () => {
    const first = nextMove('', '1. e4');
    expect(first).toMatchObject({ ok: true, value: { uci: 'e2e4', san: 'e4', color: 'w' } });

    const reply = nextMove('1. e4', '1. e4 e5');
    expect(reply).toMatchObject({ ok: true, value: { uci: 'e7e5', san: 'e5', color: 'b' } });
    expect(GameStatetoFEN(reply.value.state)).toBe(
      GameStatetoFEN(/** @type {any} */ (replayPGN('1. e4 e5')).value),
    );
  });

  it('compares moves, not text: tags, comments, spacing and check marks may differ', () => {
    const result = nextMove('1. e4 e5', '[Event "x"]\n1.e4 {main line} e5   2. Nf3');
    expect(result).toMatchObject({ ok: true, value: { uci: 'g1f3', san: 'Nf3' } });

    const check = nextMove('1. e4 f5', '1. e4 f5 2. Qh5');
    expect(check).toMatchObject({ ok: true, value: { san: 'Qh5+' } });
  });

  it('rejects a changed or removed earlier move', () => {
    expect(nextMove('1. e4 e5', '1. d4 e5 2. Nf3')).toEqual({
      ok: false,
      error: 'Move 1 was changed or removed',
      code: 'CHANGED_MOVE',
    });
    expect(nextMove('1. e4 e5 2. Nf3', '1. e4 e5')).toEqual({
      ok: false,
      error: 'Move 3 was changed or removed',
      code: 'CHANGED_MOVE',
    });
  });

  it('rejects no new move, or more than one', () => {
    expect(nextMove('1. e4', '1. e4')).toEqual({
      ok: false,
      error: 'No new move',
      code: 'NO_NEW_MOVE',
    });
    expect(nextMove('1. e4', '1. e4 e5 2. Nf3')).toEqual({
      ok: false,
      error: 'Expected one new move, found 2',
      code: 'TOO_MANY_MOVES',
    });
  });

  it('rejects an illegal new move, a move after the game ended, or a bad previous PGN', () => {
    expect(nextMove('1. e4', '1. e4 e4')).toMatchObject({
      ok: false,
      error: /Move 2 \(e4\)/,
      code: 'INVALID_PGN',
    });
    expect(nextMove('1. f3 e5 2. g4 Qh4#', '1. f3 e5 2. g4 Qh4# 3. a3')).toMatchObject({
      ok: false,
      error: /already over/,
      code: 'GAME_OVER',
    });
    expect(nextMove('1. e5', '1. e5 e5')).toMatchObject({
      ok: false,
      error: /^Previous PGN: /,
      code: 'INVALID_PREVIOUS',
    });
  });

  it('rejects any move after a final result, even if the update drops the result', () => {
    const over = { ok: false, error: 'The game is already over (1-0)', code: 'GAME_OVER' };
    expect(nextMove('1. e4 1-0', '1. e4 e5')).toEqual(over);
    expect(nextMove('1. e4 1-0', '1. e4 e5 1-0')).toEqual(over);
    expect(nextMove('1. e4 e5 1/2-1/2', '1. e4 e5 2. Nf3')).toMatchObject({
      ok: false,
      error: /already over \(1\/2-1\/2\)/,
      code: 'GAME_OVER',
    });
  });

  it('gives every error a code, so callers can branch on it', () => {
    const cases = [
      ['1. e5', '1. e4', 'INVALID_PREVIOUS'],
      ['1. f3 e5 2. g4 Qh4#', '1. f3 e5 2. g4 Qh4# 3. a3', 'GAME_OVER'],
      ['1. e4 0-1', '1. e4 e5', 'GAME_OVER'],
      ['1. e4', '1. e4 (1... c5)', 'INVALID_PGN'],
      ['1. e4', '1. d4 d5', 'CHANGED_MOVE'],
      ['1. e4', '[Event "x"] 1. e4', 'NO_NEW_MOVE'],
      ['', '1. e4 e5', 'TOO_MANY_MOVES'],
    ];
    for (const [oldPgn, newPgn, code] of cases) {
      const result = nextMove(oldPgn, newPgn);
      expect(result, `${oldPgn} -> ${newPgn}`).toMatchObject({ ok: false, code });
      expect(typeof (/** @type {any} */ (result).error)).toBe('string');
    }
  });

  it('still accepts a move after "*" (game in progress)', () => {
    expect(nextMove('1. e4 *', '1. e4 e5 *')).toMatchObject({ ok: true, value: { uci: 'e7e5' } });
  });
});

describe('agrees with chess.js on random games', () => {
  /** Small seeded random generator, so failures can be reproduced. */
  function random(seed) {
    let value = seed;
    return () => {
      value = (value * 1103515245 + 12345) % 2147483648;
      return value / 2147483648;
    };
  }

  it('writes and reads the same SAN, and replays chess.js PGN to the same position', () => {
    const next = random(210);
    for (let game = 0; game < 15; game++) {
      const reference = new Chess();
      let state = createGame();

      for (let ply = 0; ply < 120 && !reference.isGameOver(); ply++) {
        const choices = reference.moves({ verbose: true });
        expect(legalMoves(state).sort()).toEqual(choices.map((m) => m.lan).sort());

        const move = choices[Math.floor(next() * choices.length)];
        expect(toSAN(state, move.lan), `game ${game}, ${reference.fen()}`).toBe(move.san);
        expect(fromSAN(state, move.san)).toEqual({ ok: true, value: move.lan });

        state = play(state, move.lan);
        reference.move(move.san);
      }

      // chess.js writes a full PGN: tag pairs, move text and a result token.
      const replay = replayPGN(reference.pgn());
      expect(replay.ok, replay.error).toBe(true);
      expect(corePosition(GameStatetoFEN(replay.value))).toBe(corePosition(reference.fen()));
    }
  });

  it('builds the same PGN move text as chess.js, one appendMove at a time', () => {
    const next = random(42);
    const reference = new Chess();
    let pgn = '';
    for (let ply = 0; ply < 80 && !reference.isGameOver(); ply++) {
      const choices = reference.moves({ verbose: true });
      const move = choices[Math.floor(next() * choices.length)];
      const appended = appendMove(pgn, move.lan);
      expect(appended.ok, appended.error).toBe(true);
      pgn = appended.value.pgn;
      reference.move(move.san);
    }
    const moveText = reference.pgn().split('\n').pop().replace(/ \*$/, '');
    expect(pgn).toBe(moveText);
  });
});
