import { describe, expect, it } from 'vitest';
import { SQUARES, fromSquare, sqIndex, sqName, toSquare } from '../0x88helper.js';
import { applyMove, getGameStatus, isInCheck } from '../gameState.js';
import { moveGenerator } from '../moveGeneration.js';
import { FENtoGameState, GameStatetoFEN } from '../notation.js';

describe('isInCheck', () => {
  it('returns false in the starting position', () => {
    const state = FENtoGameState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');

    expect(isInCheck(state)).toBe(false);
  });

  it('detects a direct attack on the side to move', () => {
    const state = FENtoGameState('4r1k1/8/8/8/8/8/8/4K3 w - - 0 1');
    expect(isInCheck(state)).toBe(true);

    state.currentTurn = 'b';
    expect(isInCheck(state)).toBe(false);
  });

  it('detects a discovered attack after a blocking piece moves away', () => {
    const blocked = FENtoGameState('4r1k1/8/8/4b3/8/8/8/4K3 w - - 0 1');
    const exposed = FENtoGameState('4r1k1/8/8/8/5b2/8/8/4K3 w - - 0 1');

    expect(isInCheck(blocked)).toBe(false);
    expect(isInCheck(exposed)).toBe(true);
  });
});

describe('getGameStatus', () => {
  it('returns active for the starting position', () => {
    const state = FENtoGameState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');

    expect(getGameStatus(state)).toEqual({
      status: 'active',
      winner: null,
      drawReason: null,
    });
  });

  it('detects Fool’s Mate and names Black as the winner', () => {
    const state = FENtoGameState('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');

    expect(getGameStatus(state)).toEqual({
      status: 'checkmate',
      winner: 'b',
      drawReason: null,
    });
  });

  it('detects checkmate when White wins', () => {
    const state = FENtoGameState('7k/6Q1/5K2/8/8/8/8/8 b - - 0 1');

    expect(getGameStatus(state)).toEqual({
      status: 'checkmate',
      winner: 'w',
      drawReason: null,
    });
  });

  it('detects stalemate', () => {
    const state = FENtoGameState('k7/8/1QK5/8/8/8/8/8 b - - 0 1');

    expect(getGameStatus(state)).toEqual({
      status: 'stalemate',
      winner: null,
      drawReason: 'stalemate',
    });
  });

  it('keeps the game active when the checked king can escape', () => {
    const state = FENtoGameState('4r1k1/8/8/8/8/8/8/4K3 w - - 0 1');

    expect(getGameStatus(state)).toEqual({
      status: 'active',
      winner: null,
      drawReason: null,
    });
  });
});

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function play(state, uci) {
  const result = applyMove(state, uci);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

/** Deep-freeze an object so any mutation throws in strict mode. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
  }
  return value;
}

describe('applyMove', () => {
  it('parses a legal move, advances turn and clocks, records history, and leaves input untouched', () => {
    const initial = FENtoGameState(START);
    const snapshot = structuredClone(initial);
    const afterWhite = play(initial, 'e2e4');

    expect(initial).toEqual(snapshot);
    expect(afterWhite).not.toBe(initial);
    expect(afterWhite.board).not.toBe(initial.board);
    expect(afterWhite.castlingRights).not.toBe(initial.castlingRights);
    expect(GameStatetoFEN(afterWhite)).toBe(
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    );
    expect(afterWhite.moveHistory).toEqual([{ from: { row: 6, col: 4 }, to: { row: 4, col: 4 } }]);
    expect(afterWhite.positionHistory).toEqual([
      START.split(' ').slice(0, 4).join(' '),
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -',
    ]);
    expect(afterWhite.status).toBe('active');

    const afterBlack = play(afterWhite, 'c7c5');
    expect(afterBlack.fullmoveNumber).toBe(2);
    expect(afterBlack.halfmoveClock).toBe(0);
    expect(afterBlack.enPassantTarget).toBe(sqIndex('c6'));
    expect(afterBlack.moveHistory).toHaveLength(2);
    expect(afterBlack.positionHistory).toHaveLength(3);
  });

  it('rejects malformed, out-of-turn, impossible, and incorrectly suffixed moves', () => {
    const state = FENtoGameState(START);
    for (const uci of ['bad', 'e2e9', 'e2e4x', 'e7e5', 'e2e5', 'e2e4q']) {
      expect(applyMove(state, uci).ok).toBe(false);
    }
    expect(GameStatetoFEN(state)).toBe(START);
    expect(state.moveHistory).toEqual([]);
  });

  it('returns a Result error for a broken state instead of throwing', () => {
    expect(applyMove(null, 'e2e4')).toEqual({ ok: false, error: 'Invalid game state' });
    expect(applyMove({}, 'e2e4')).toEqual({ ok: false, error: 'Invalid game state' });
    const noHistory = { ...FENtoGameState(START), moveHistory: undefined };
    expect(applyMove(noHistory, 'e2e4')).toEqual({ ok: false, error: 'Invalid game state' });
  });

  it('never mutates its input, even when old and new states share pieces', () => {
    // Every state is deep-frozen, so any write to a shared piece or move record throws.
    const games = [
      [START, ['e2e4', 'd7d5', 'e4d5', 'g8f6', 'g1f3', 'f6d5', 'f1c4', 'e7e6', 'e1g1']],
      [START, ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6']], // en passant
      ['1n5k/P7/8/8/8/8/8/K7 w - - 0 1', ['a7b8q']], // promotion with capture
    ];
    for (const [fen, moves] of games) {
      let state = deepFreeze(FENtoGameState(fen));
      for (const uci of moves) {
        const snapshot = structuredClone(state);
        const result = applyMove(state, uci);
        expect(result, `${uci}: ${result.error}`).toMatchObject({ ok: true });
        expect(state).toEqual(snapshot);
        state = deepFreeze(result.value);
      }
    }
  });

  it('updates quiet-move and capture clocks, including rook rights on capture', () => {
    const state = FENtoGameState('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 4 7');
    const after = play(state, 'a1a8');
    expect(GameStatetoFEN(after)).toBe('R3k2r/8/8/8/8/8/8/4K2R b Kk - 0 7');
    expect(state.castlingRights.wQueenside).toBe(true);
    const quiet = play(FENtoGameState('4k3/8/8/8/8/8/8/4K2R w K - 4 7'), 'h1h2');
    expect(quiet.halfmoveClock).toBe(5);
    expect(quiet.castlingRights.wKingside).toBe(false);
  });

  it('moves the rook when castling on either side and clears king rights', () => {
    const white = play(FENtoGameState('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'), 'e1g1');
    expect(GameStatetoFEN(white)).toBe('r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1');
    const black = play(FENtoGameState('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1'), 'e8c8');
    expect(GameStatetoFEN(black)).toBe('2kr3r/8/8/8/8/8/8/R3K2R w KQ - 1 2');
    expect(applyMove(FENtoGameState('4kr1r/8/8/8/8/8/8/4K3 b k - 0 1'), 'e8g8').ok).toBe(false);
  });

  it('captures en passant and expires the target after a different move', () => {
    const state = FENtoGameState('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
    const capture = play(state, 'e5d6');
    expect(GameStatetoFEN(capture)).toBe('4k3/8/3P4/8/8/8/8/4K3 b - - 0 2');
    expect(capture.board[sqIndex('d5')]).toBeNull();
    expect(state.board[sqIndex('d5')]).toEqual({ color: 'b', type: 'p' });
    expect(play(state, 'e1e2').enPassantTarget).toBeNull();
  });

  it('records en passant in the repetition key only when the capture is legal', () => {
    const legal = play(FENtoGameState('k7/3p4/8/4P3/8/8/8/4K3 b - - 0 1'), 'd7d5');
    expect(legal.positionHistory.at(-1)).toBe('k7/8/8/3pP3/8/8/8/4K3 w - d6');

    const pinned = play(FENtoGameState('k3r3/3p4/8/4P3/8/8/8/4K3 b - - 0 1'), 'd7d5');
    expect(GameStatetoFEN(pinned).split(' ')[3]).toBe('d6');
    expect(pinned.positionHistory.at(-1)).toBe('k3r3/8/8/3pP3/8/8/8/4K3 w - -');
    expect(applyMove(pinned, 'e5d6').ok).toBe(false);
  });

  it.each(['q', 'r', 'b', 'n'])('requires and records promotion to %s', (kind) => {
    const state = FENtoGameState('7k/P7/8/8/8/8/8/4K3 w - - 0 1');
    expect(applyMove(state, 'a7a8').ok).toBe(false);
    const next = play(state, `a7a8${kind}`);
    expect(next.board[sqIndex('a8')]).toEqual({ color: 'w', type: kind });
    expect(next.moveHistory[0].promotion).toBe(kind);
    expect(next.halfmoveClock).toBe(0);
  });

  it('fills in checkmate status and rejects moves after the game ends', () => {
    let state = FENtoGameState(START);
    for (const uci of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) {
      state = play(state, uci);
    }
    expect(state).toMatchObject({ status: 'checkmate', winner: 'b', drawReason: null });
    expect(applyMove(state, 'e2e4').ok).toBe(false);
  });
});

describe('repetition history', () => {
  it('stores the same first four FEN fields as GameStatetoFEN, over random games', () => {
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);
    for (let game = 0; game < 20; game++) {
      let state = FENtoGameState(START);
      for (let ply = 0; ply < 80 && state.status === 'active'; ply++) {
        const moves = [];
        for (const index of SQUARES) {
          if (state.board[index]?.color === state.currentTurn) {
            for (const to of moveGenerator(state, toSquare(index))) {
              const uci = sqName(index) + sqName(fromSquare(to));
              const lastRow = state.currentTurn === 'w' ? 0 : 7;
              moves.push(state.board[index].type === 'p' && to.row === lastRow ? uci + 'q' : uci);
            }
          }
        }
        state = play(state, moves[Math.floor(random() * moves.length)]);
        const [placement, turn, castling, enPassant] = GameStatetoFEN(state).split(' ');
        const [keyPlacement, keyTurn, keyCastling, keyEnPassant] = state.positionHistory
          .at(-1)
          .split(' ');
        expect([keyPlacement, keyTurn, keyCastling]).toEqual([placement, turn, castling]);
        // The key drops an en passant square that no pawn can actually capture.
        expect(keyEnPassant === '-' || keyEnPassant === enPassant).toBe(true);
      }
    }
  });
});
