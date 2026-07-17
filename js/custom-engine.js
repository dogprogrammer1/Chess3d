/*
 * Direct client for the user's CustomChessEngine. The engine stays in a module
 * worker so its deeper classical alpha-beta search never blocks board input.
 * NNUE is intentionally never selected or asked to load a model here.
 */
(function () {
  'use strict';

  const MAX_DEPTH = 10;
  // The local server exposes the application at its root. An absolute route
  // prevents a nested page from resolving this as e.g. tools/js/worker.js.
  const WORKER_URL = '/js/custom-engine-worker.js';

  class CustomChessEngine {
    constructor() {
      this.worker = null;
      this.requestId = 0;
      this.pending = new Map();
    }

    ensureWorker() {
      if (this.worker) return;
      this.worker = new Worker(WORKER_URL, { type: 'module', name: 'Tournament Room Custom Engine' });
      this.worker.addEventListener('message', event => {
        const response = event.data;
        const pending = this.pending.get(response.requestId);
        if (!pending) return;
        this.pending.delete(response.requestId);
        if (response.type === 'error') { pending.reject(new Error(response.message)); return; }
        if (!response.move) { pending.resolve(null); return; }
        pending.resolve({
          move: response.move,
          score: Number(response.score || 0),
          depth: response.depth,
          nodes: response.nodes || 0,
          elapsedMs: response.elapsedMs || 0,
          style: 'Original CustomChessEngine | classical evaluation | aggressive | approximately 1900',
        });
      });
      this.worker.addEventListener('error', event => {
        const details = [event.message, event.filename, event.lineno ? `line ${event.lineno}` : ''].filter(Boolean).join(' · ');
        const error = new Error(details || 'CustomChessEngine could not load. Restart the local server and try again.');
        this.rejectAll(error);
        this.worker?.terminate();
        this.worker = null;
      });
    }

    chooseMove(game, requestedDepth = 4) {
      this.ensureWorker();
      const requestId = ++this.requestId;
      const depth = Math.max(1, Math.min(MAX_DEPTH, Number(requestedDepth) || 4));
      return new Promise((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject });
        this.worker.postMessage({
          type: 'findBestMove',
          requestId,
          fen: game.fen(),
          color: game.turn === 'w' ? 0 : 1,
          depth,
          evaluator: 'classical',
        });
      });
    }

    cancel() {
      if (!this.worker) return;
      this.worker.terminate();
      this.worker = null;
      this.rejectAll(new Error('Custom engine search cancelled.'));
    }

    rejectAll(error) {
      this.pending.forEach(({ reject }) => reject(error));
      this.pending.clear();
    }
  }

  window.TournamentCustomEngine = { CustomChessEngine, MAX_DEPTH };
})();
