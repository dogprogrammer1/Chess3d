import { spawn } from 'node:child_process';
import readline from 'node:readline';

function integerMatch(line, pattern, fallback = 0) {
  const match = line.match(pattern);
  return match ? Number(match[1]) : fallback;
}

export function parseUciInfo(line) {
  if (!line.startsWith('info ') || !/\bpv\s+/.test(line)) return null;
  const score = line.match(/\bscore (cp|mate) (-?\d+)/);
  const pv = line.match(/\bpv (.+)$/);
  if (!score || !pv) return null;
  const wdl = line.match(/\bwdl (\d+) (\d+) (\d+)/);
  return {
    rank: integerMatch(line, /\bmultipv (\d+)/, 1),
    scoreType: score[1],
    score: Number(score[2]),
    pv: pv[1],
    nodes: integerMatch(line, /\bnodes (\d+)/),
    depth: integerMatch(line, /\bdepth (\d+)/),
    wdl: wdl ? wdl.slice(1).map(Number) : [],
  };
}

class LineQueue {
  constructor() {
    this.lines = [];
    this.waiters = [];
    this.closedError = null;
  }

  push(line) {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(line);
    else this.lines.push(line);
  }

  close(error) {
    this.closedError = error;
    this.waiters.splice(0).forEach(waiter => waiter.reject(error));
  }

  async next(timeoutMs) {
    if (this.lines.length) return this.lines.shift();
    if (this.closedError) throw this.closedError;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Stockfish did not respond within ${timeoutMs} ms.`));
      }, timeoutMs);
      waiter.resolve = value => { clearTimeout(timer); resolve(value); };
      waiter.reject = error => { clearTimeout(timer); reject(error); };
    });
  }
}

export class UciStockfishClient {
  constructor(enginePath, { threads = 1, hashMb = 128, timeoutMs = 120000 } = {}) {
    this.enginePath = enginePath;
    this.threads = threads;
    this.hashMb = hashMb;
    this.timeoutMs = timeoutMs;
    this.process = null;
    this.queue = new LineQueue();
    this.stderr = [];
  }

  send(command) {
    if (!this.process || this.process.killed || !this.process.stdin.writable) {
      throw new Error('Stockfish is not running.');
    }
    this.process.stdin.write(`${command}\n`);
  }

  async waitFor(expected) {
    while (true) {
      const line = await this.queue.next(this.timeoutMs);
      if (line === expected) return;
    }
  }

  async connect() {
    if (this.process) return;
    const queue = this.queue;
    this.process = spawn(this.enginePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const output = readline.createInterface({ input: this.process.stdout });
    output.on('line', line => queue.push(line));
    const errors = readline.createInterface({ input: this.process.stderr });
    errors.on('line', line => {
      this.stderr.push(line);
      if (this.stderr.length > 20) this.stderr.shift();
    });
    this.process.once('error', error => queue.close(error));
    this.process.once('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      queue.close(new Error(`Stockfish exited with ${reason}.${this.stderr.length ? ` ${this.stderr.join(' ')}` : ''}`));
    });
    this.send('uci');
    await this.waitFor('uciok');
    this.send(`setoption name Threads value ${this.threads}`);
    this.send(`setoption name Hash value ${this.hashMb}`);
    this.send('setoption name UCI_ShowWDL value true');
    this.send('isready');
    await this.waitFor('readyok');
  }

  async restart() {
    this.close();
    this.queue = new LineQueue();
    this.stderr = [];
    await this.connect();
  }

  async analyze(fen, { depth = 12, multiPv = 3 } = {}) {
    this.send(`setoption name MultiPV value ${multiPv}`);
    this.send(`position fen ${fen}`);
    this.send(`go depth ${depth}`);
    const lines = new Map();
    while (true) {
      const line = await this.queue.next(this.timeoutMs);
      const info = parseUciInfo(line);
      if (info && (!lines.has(info.rank) || info.depth >= lines.get(info.rank).depth)) lines.set(info.rank, info);
      const bestMove = line.match(/^bestmove (\S+)/);
      if (!bestMove) continue;
      const ordered = [...lines.values()].sort((left, right) => left.rank - right.rank);
      const top = ordered[0] || { scoreType: 'cp', score: 0, pv: '', nodes: 0, depth: 0, wdl: [] };
      return {
        scoreType: top.scoreType,
        score: top.score,
        pv: top.pv,
        nodes: top.nodes,
        depth: top.depth,
        wdl: top.wdl,
        lines: ordered,
        move: bestMove[1],
      };
    }
  }

  close() {
    if (!this.process) return;
    const process = this.process;
    this.process = null;
    if (!process.killed && process.stdin.writable) process.stdin.end('quit\n');
    const timer = setTimeout(() => { if (!process.killed) process.kill(); }, 1000);
    timer.unref?.();
  }
}
