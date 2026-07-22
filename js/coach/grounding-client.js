/* Optional local client for the trained chess-grounding checkpoint service. */
(function () {
  'use strict';

  const PREDICTION_SCHEMA = 'tournament-room.chess-grounding-prediction.v1';

  class GroundingCoachClient {
    constructor({ url = 'http://127.0.0.1:8770', timeoutMs = 5000, fetchImpl = globalThis.fetch } = {}) {
      this.url = String(url).replace(/\/$/, '');
      this.timeoutMs = timeoutMs;
      // Window.fetch requires its browser receiver. Wrap it so calling through
      // the client never changes the function's `this` value.
      this.fetch = typeof fetchImpl === 'function' ? (...args) => fetchImpl(...args) : fetchImpl;
      this.status = 'offline';
      this.model = null;
      this.detail = 'Neural model offline.';
      this.listeners = new Set();
      this.connectPromise = null;
    }

    onStatus(listener) {
      this.listeners.add(listener);
      listener(this.status, this.model, this.detail);
      return () => this.listeners.delete(listener);
    }

    setStatus(status, detail = '', model = this.model) {
      this.status = status;
      this.model = model;
      this.detail = detail;
      this.listeners.forEach(listener => listener(status, model, detail));
    }

    async request(path, options = {}) {
      if (typeof this.fetch !== 'function') throw new Error('Grounding inference is unavailable in this browser.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetch(`${this.url}${path}`, { ...options, signal: controller.signal });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || `Grounding service returned HTTP ${response.status}.`);
        return payload;
      } catch (error) {
        const message = error?.name === 'AbortError' ? 'Grounding inference timed out.' : (error?.message || 'Grounding inference is unavailable.');
        this.setStatus('offline', message);
        throw new Error(message);
      } finally {
        clearTimeout(timer);
      }
    }

    connect() {
      if (this.status === 'online') return Promise.resolve(this.model);
      if (this.connectPromise) return this.connectPromise;
      this.setStatus('connecting', 'Connecting the neural chess model...');
      this.connectPromise = this.request('/health').then(payload => {
        if (payload.status !== 'ok') throw new Error('Grounding service health check failed.');
        const model = payload.model || null;
        this.setStatus('online', 'Neural chess model ready.', model);
        return model;
      }).catch(error => {
        if (this.status !== 'offline') this.setStatus('offline', error.message || 'Grounding inference is unavailable.');
        throw error;
      }).finally(() => { this.connectPromise = null; });
      return this.connectPromise;
    }

    async predict(payload) {
      if (this.status !== 'online') this.setStatus('connecting', 'Running neural chess inference...');
      const result = await this.request('/v1/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, topK: 5 }),
      });
      if (result.schema !== PREDICTION_SCHEMA) {
        const error = new Error('The grounding service returned an unsupported response.');
        this.setStatus('offline', error.message);
        throw error;
      }
      this.setStatus('online', 'Neural chess model ready.', result.model || this.model);
      return result;
    }

    predictMove({ entry, beforeAnalysis, afterAnalysis, beforeFeatures, afterFeatures, loss, legalMoves }) {
      return this.predict({
        fen: entry.beforeFen,
        playedMove: entry.uci,
        legalMoves,
        mover: entry.move.piece.color,
        loss,
        engine: { before: beforeAnalysis, after: afterAnalysis },
        features: { before: beforeFeatures, after: afterFeatures },
      });
    }

    predictPosition({ fen, analysis, features, mover, legalMoves }) {
      return this.predict({
        fen,
        legalMoves,
        mover,
        engine: { before: analysis, after: analysis },
        features: { before: features, after: features },
      });
    }
  }

  window.TournamentGrounding = { GroundingCoachClient, PREDICTION_SCHEMA };
})();
