/* Browser-safe client for the local Stockfish sidecar. Browsers cannot launch
 * a Windows .exe directly, so the optional bridge owns the UCI process and
 * exposes only WebSocket messages on localhost. */
(function () {
  'use strict';

  class StockfishClient {
    constructor(url = 'ws://127.0.0.1:8765/') {
      this.url = url;
      this.socket = null;
      this.status = 'offline';
      this.listeners = new Set();
      this.requestId = 0;
      this.pending = new Map();
    }

    onStatus(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    emit(status, detail = '') { this.status = status; this.listeners.forEach(listener => listener(status, detail)); }

    connect() {
      if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
      if (this.socket?.readyState === WebSocket.CONNECTING) return this.connection;
      this.emit('connecting');
      let socket;
      try { socket = new WebSocket(this.url); }
      catch (error) { this.emit('offline', error.message); return Promise.reject(error); }
      this.socket = socket;
      this.connection = new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
          if (!done) {
            done = true; socket.close(); reject(new Error('Connection timed out.'));
            if (socket === this.socket) this.emit('offline', 'The local bridge did not answer.');
          }
        }, 2500);
        socket.addEventListener('open', () => {
          if (done || socket !== this.socket) return;
          done = true; clearTimeout(timer); this.emit('online'); resolve();
        });
        socket.addEventListener('message', event => { if (socket === this.socket) this.handleMessage(event); });
        socket.addEventListener('error', () => {
          if (done) return;
          done = true; clearTimeout(timer); reject(new Error('Bridge unavailable.'));
          if (socket === this.socket) this.emit('offline', 'Could not connect to the local bridge.');
        });
        socket.addEventListener('close', () => {
          clearTimeout(timer);
          if (!done) { done = true; reject(new Error('Stockfish connection closed.')); }
          if (socket !== this.socket) return;
          this.socket = null;
          this.pending.forEach(({ reject }) => reject(new Error('Stockfish connection closed.')));
          this.pending.clear();
          if (this.status !== 'offline') this.emit('offline', 'Engine connection closed.');
        });
      });
      return this.connection;
    }

    handleMessage(event) {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'error') this.emit('online', message.message);
        if (message.type === 'analysis' && this.onAnalysis) this.onAnalysis(message);
        if (message.type === 'bestmove' && this.onBestMove) this.onBestMove(message);
        const pending = this.pending.get(message.requestId);
        if (pending) {
          this.pending.delete(message.requestId);
          if (message.type === 'error') pending.reject(new Error(message.message || 'Stockfish analysis failed.'));
          else pending.resolve(message);
        }
      } catch { /* Ignore malformed local messages. */ }
    }

    send(message) {
      if (this.socket?.readyState !== WebSocket.OPEN) return false;
      const requestId = ++this.requestId;
      this.socket.send(JSON.stringify({ ...message, requestId }));
      return requestId;
    }
    request(message) {
      const requestId = this.send(message);
      if (!requestId) return Promise.reject(new Error('Stockfish is not connected.'));
      return new Promise((resolve, reject) => this.pending.set(requestId, { resolve, reject }));
    }
    analyse(fen, depth = 14) { return this.send({ type: 'analyse', fen, depth }); }
    analysePosition(fen, { depth = 14, multiPv = 3 } = {}) {
      return this.request({ type: 'analyse', fen, depth, multiPv });
    }
    requestMove(fen, depth = 14) { return this.send({ type: 'move', fen, depth }); }
    close() {
      this.socket?.close();
      this.socket = null;
      this.pending.forEach(({ reject }) => reject(new Error('Stockfish connection closed.')));
      this.pending.clear();
      this.emit('offline');
    }
  }

  window.TournamentEngine = { StockfishClient };
})();
