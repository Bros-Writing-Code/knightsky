import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadOurs(root = process.env.BENCH_ENGINE_ROOT || process.cwd()) {
  const entry = resolve(root, 'src/engine/index.js');
  // Vitest loads plain paths but can't find %-encoded file URLs (a space becomes %20);
  // plain Node needs a file URL. Forward slashes keep Windows paths valid for Vite.
  const api = await import(
    /* @vite-ignore */ process.env.VITEST ? entry.replaceAll('\\', '/') : pathToFileURL(entry).href
  );
  for (const name of [
    'createGame',
    'applyMove',
    'legalMoves',
    'isValidMove',
    'getGameStatus',
    'replayMoves',
    'GameStatetoFEN',
  ]) {
    if (typeof api[name] !== 'function') {
      throw new Error(`Unsupported engine: missing ${name}`);
    }
  }
  function unwrap(result) {
    if (!result || result.ok !== true || !result.value) {
      throw new Error(result?.error || 'Expected Result<GameState> from engine API');
    }
    return result.value;
  }
  return {
    id: 'ours',
    load: api.createGame,
    fen: api.GameStatetoFEN,
    moves: api.legalMoves,
    valid: api.isValidMove,
    status: api.getGameStatus,
    move: (state, uci) => unwrap(api.applyMove(state, uci)),
    replay: (moves, fen) => unwrap(api.replayMoves(moves, fen)),
    pgn: typeof api.replayPGN === 'function' ? (pgn) => unwrap(api.replayPGN(pgn)) : null,
  };
}
