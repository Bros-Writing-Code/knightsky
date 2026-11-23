# Lexicon

Our overall design principle is to treat opponents' moves as untrusted user data. We always validate their moves on our client with the chess engine to ensure that we agree on the current state of the game.

## The Architecture: Updates to Game Records

| **Record** | **Data**                                                                                                                                   | **Purpose**                                                                                                              |
|------------|--------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------|
| `game`       | opponent DID, color, optional challenge strong ref, pgn, fen, and status (active / resigned)                                               | Tracks full game state, move history, and also acts as a challenge to another player or an acceptance of that challenge. |
| `reject`     | subject strong ref (points to opponent's offending game record update), reason code, optional message  | Exists as a request for opponent to redo their previous move after performing an illegal one.                            |

In this version of the system, the gameplay process would look like the following:
