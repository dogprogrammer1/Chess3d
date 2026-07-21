/* Persistence boundary. Today this uses browser-local storage; later the same
 * GameRecord shape can be written to a signed-in account service or a chosen
 * local-folder adapter without changing the game or renderer layers. */
(function () {
  'use strict';

  const KEY = 'tournament-room.session.v1';

  class GameStorage {
    saveSession(game, settings) {
      const record = {
        schemaVersion: 2,
        savedAt: new Date().toISOString(),
        startFen: game.history[0]?.beforeFen || game.fen(),
        fen: game.fen(),
        pgn: game.pgn(),
        moves: game.history.map(entry => ({ uci: entry.uci, san: entry.san, fen: entry.fen })),
        settings: { ...settings },
      };
      localStorage.setItem(KEY, JSON.stringify(record));
      return record;
    }

    loadSession() {
      try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return null;
        const record = JSON.parse(raw);
        return [1, 2].includes(record?.schemaVersion) && record.fen ? record : null;
      } catch {
        return null;
      }
    }

    downloadPgn(game) {
      const date = new Date().toISOString().slice(0, 10);
      const blob = new Blob([game.pgn()], { type: 'application/x-chess-pgn;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `tournament-room-${date}.pgn`;
      anchor.click();
      URL.revokeObjectURL(url);
    }
  }

  window.TournamentStorage = { GameStorage };
})();
