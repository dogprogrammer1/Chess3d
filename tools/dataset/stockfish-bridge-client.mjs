export class StockfishBridgeClient {
  constructor(url = 'ws://127.0.0.1:8765/', { timeoutMs = 120000 } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.requestId = 0;
    this.pending = new Map();
  }

  async connect() {
    if (typeof WebSocket === 'undefined') {
      throw new Error('This dataset builder requires Node.js 22 or newer for WebSocket support.');
    }
    if (this.socket?.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error(`Stockfish bridge connection timed out: ${this.url}`));
      }, 5000);
      socket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket = socket;
        socket.addEventListener('message', event => this.handleMessage(event));
        socket.addEventListener('close', () => this.rejectPending(new Error('Stockfish bridge connection closed.')));
        resolve();
      });
      socket.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Could not connect to the Stockfish bridge at ${this.url}`));
      });
    });
  }

  handleMessage(event) {
    let message;
    try { message = JSON.parse(event.data); }
    catch { return; }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    if (message.type === 'error') pending.reject(new Error(message.message || 'Stockfish analysis failed.'));
    else pending.resolve(message);
  }

  rejectPending(error) {
    this.pending.forEach(pending => {
      clearTimeout(pending.timer);
      pending.reject(error);
    });
    this.pending.clear();
  }

  request(payload) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Stockfish bridge is not connected.');
    const requestId = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Stockfish analysis timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ ...payload, requestId }));
    });
  }

  analyze(fen, { depth = 12, multiPv = 3 } = {}) {
    return this.request({ type: 'analyse', fen, depth, multiPv });
  }

  close() {
    this.socket?.close();
    this.socket = null;
    this.rejectPending(new Error('Stockfish bridge client closed.'));
  }
}
