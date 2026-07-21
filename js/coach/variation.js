/* Converts engine UCI lines into legal SAN frames for board preview. */
(function () {
  'use strict';

  const { ChessGame } = window.ChessDomain;

  function build(startFen, pv, maxPlies = 10) {
    const game = new ChessGame(startFen);
    const tokens = Array.isArray(pv) ? pv : String(pv || '').trim().split(/\s+/).filter(Boolean);
    const frames = [{ fen: startFen, san: '', uci: '', ply: 0 }];
    for (const uci of tokens.slice(0, maxPlies)) {
      const move = game.moveFromUci(uci);
      if (!move) break;
      const { san } = game.apply(move);
      frames.push({ fen: game.fen(), san, uci, ply: frames.length });
      if (game.result) break;
    }
    return {
      startFen,
      frames,
      san: frames.slice(1).map(frame => frame.san).join(' '),
      projectedFen: frames.at(-1).fen,
    };
  }

  window.TournamentCoachVariation = { build };
})();
