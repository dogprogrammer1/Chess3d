// Runs the user's original CustomChessEngine in a module worker. The adapter
// converts Tournament Room's FEN into the bitboard state the original engine
// expects, then converts its selected move straight back to UCI.
import Board from '/CustomChessEngine/board.js';
import Engine from '/CustomChessEngine/engine.js';

const FILES = 'abcdefgh';
const PIECE_TYPES = { p: 0, b: 1, n: 2, r: 3, q: 4, k: 5 };

function stateFromFen(fen) {
  const [placement, turn, castling, ep, halfmove, fullmove] = fen.split(' ');
  const board = Array.from({ length: 2 }, () => Array(6).fill(0n));
  const ranks = placement.split('/');
  if (ranks.length !== 8) throw new Error('Custom engine received an invalid FEN.');
  ranks.forEach((rank, y) => {
    let x = 0;
    for (const token of rank) {
      if (/\d/.test(token)) { x += Number(token); continue; }
      const color = token === token.toUpperCase() ? 0 : 1;
      const type = PIECE_TYPES[token.toLowerCase()];
      if (type === undefined || x > 7) throw new Error('Custom engine received an invalid board layout.');
      board[color][type] |= 1n << BigInt(8 * y + x);
      x += 1;
    }
    if (x !== 8) throw new Error('Custom engine received an invalid board rank.');
  });
  const epCoords = ep === '-' ? [-1, -1] : [FILES.indexOf(ep[0]), 8 - Number(ep[1])];
  return {
    board,
    castle: [castling.includes('K'), castling.includes('Q'), castling.includes('k'), castling.includes('q')],
    ep: epCoords,
    turn: turn === 'w' ? 0 : 1,
    halfmoveClock: Number(halfmove),
    fullmoveNumber: Number(fullmove),
    gameResult: null,
  };
}

function toUci(move, board) {
  const movingPiece = board.getPiece(move.x1, move.y1);
  const promotion = movingPiece[1] === 0 && (move.y2 === 0 || move.y2 === 7) ? 'q' : '';
  return `${FILES[move.x1]}${8 - move.y1}${FILES[move.x2]}${8 - move.y2}${promotion}`;
}

self.addEventListener('message', event => {
  const request = event.data;
  if (request.type !== 'findBestMove') return;
  try {
    const board = new Board(0, { silent: true });
    board.restoreState(stateFromFen(request.fen));
    // Classical only: the user's hand-tuned material, piece-square, pawn
    // structure, and king-safety evaluator. The NNUE evaluation path is
    // deliberately never selected.
    const engine = new Engine(board, request.color, 'classical');
    const started = performance.now();
    const bestMove = engine.findBestMove(request.depth);
    const elapsedMs = performance.now() - started;
    self.postMessage({
      type: 'bestMove',
      requestId: request.requestId,
      move: bestMove ? toUci(bestMove, board) : null,
      score: engine.evaluateBoard(),
      depth: Math.min(Number(request.depth), 10),
      nodes: engine.nodesEvaluated,
      elapsedMs,
      evaluator: 'classical',
    });
  } catch (error) {
    self.postMessage({ type: 'error', requestId: request.requestId, message: error.message });
  }
});
