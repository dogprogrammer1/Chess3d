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
    }

    onStatus(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    emit(status, detail = '') { this.status = status; this.listeners.forEach(listener => listener(status, detail)); }

    connect() {
      if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
      if (this.socket?.readyState === WebSocket.CONNECTING) return this.connection;
      this.emit('connecting');
      this.connection = new Promise((resolve, reject) => {
        let done = false;
        const socket = new WebSocket(this.url);
        this.socket = socket;
        const timer = setTimeout(() => {
          if (!done) { done = true; socket.close(); this.emit('offline', 'The local bridge did not answer.'); reject(new Error('Connection timed out.')); }
        }, 2500);
        socket.addEventListener('open', () => { if (!done) { done = true; clearTimeout(timer); this.emit('online'); resolve(); } });
        socket.addEventListener('message', event => this.handleMessage(event));
        socket.addEventListener('error', () => { if (!done) { done = true; clearTimeout(timer); this.emit('offline', 'Could not connect to the local bridge.'); reject(new Error('Bridge unavailable.')); } });
        socket.addEventListener('close', () => { if (this.status !== 'offline') this.emit('offline', 'Engine connection closed.'); });
      });
      return this.connection;
    }

    handleMessage(event) {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'error') this.emit('online', message.message);
        if (message.type === 'analysis' && this.onAnalysis) this.onAnalysis(message);
        if (message.type === 'bestmove' && this.onBestMove) this.onBestMove(message);
      } catch { /* Ignore malformed local messages. */ }
    }

    send(message) {
      if (this.socket?.readyState !== WebSocket.OPEN) return false;
      this.socket.send(JSON.stringify({ ...message, requestId: ++this.requestId }));
      return true;
    }
    analyse(fen, depth = 14) { return this.send({ type: 'analyse', fen, depth }); }
    requestMove(fen, depth = 14) { return this.send({ type: 'move', fen, depth }); }
    close() { this.socket?.close(); this.socket = null; this.emit('offline'); }
  }

  window.TournamentEngine = { StockfishClient };
})();
