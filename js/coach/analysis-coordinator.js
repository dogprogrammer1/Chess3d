/* Caches structured Stockfish requests so before-move work can be reused. */
(function () {
  'use strict';

  class AnalysisCoordinator {
    constructor(engine, limit = 64) {
      this.engine = engine;
      this.limit = limit;
      this.cache = new Map();
    }

    analyze(fen, depth = 14, multiPv = 3) {
      const key = `${fen}|${depth}|${multiPv}`;
      if (this.cache.has(key)) return this.cache.get(key);
      const request = this.engine.analysePosition(fen, { depth, multiPv }).then(message => ({
        ...message,
        lines: Array.isArray(message.lines) && message.lines.length ? message.lines : [{
          rank: 1,
          scoreType: message.scoreType,
          score: message.score,
          pv: message.pv,
          nodes: message.nodes,
          depth: message.depth,
          wdl: message.wdl || [],
        }],
      })).catch(error => {
        this.cache.delete(key);
        throw error;
      });
      this.cache.set(key, request);
      while (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value);
      return request;
    }

    clear() { this.cache.clear(); }
  }

  window.TournamentCoachAnalysis = { AnalysisCoordinator };
})();
