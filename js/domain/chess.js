/*
 * Chess domain layer: rules, FEN/PGN state, and move notation.
 * It is intentionally UI-agnostic so it can later be shared by desktop,
 * account-sync, and saved-game adapters.
 */
/* Chess rules and notation domain. */
(function () {
  'use strict';

  const FILES = 'abcdefgh';
  const PIECES = {
    w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕', k: '♔' },
    b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' },
  };
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  function opposite(color) { return color === 'w' ? 'b' : 'w'; }
  function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
  function squareName(r, c) { return `${FILES[c]}${8 - r}`; }
  function squareCoords(name) { return { r: 8 - Number(name[1]), c: FILES.indexOf(name[0]) }; }
  function cloneBoard(board) { return board.map(row => row.map(piece => piece ? { ...piece } : null)); }
  function cloneMove(move) { return { ...move, from: { ...move.from }, to: { ...move.to } }; }

  class ChessGame {
    constructor(fen = START_FEN) {
      this.loadFen(fen);
      this.history = [];
      this.positionCounts = new Map([[this.positionKey(), 1]]);
      this.result = null;
    }

    loadFen(fen) {
      const [placement, turn, rights, ep, halfmove = '0', fullmove = '1'] = fen.split(' ');
      const ranks = placement.split('/');
      if (ranks.length !== 8) throw new Error('Invalid FEN board layout.');
      this.board = ranks.map((rank, r) => {
        const row = [];
        for (const token of rank) {
          if (/\d/.test(token)) {
            for (let i = 0; i < Number(token); i += 1) row.push(null);
          } else {
            row.push({ type: token.toLowerCase(), color: token === token.toUpperCase() ? 'w' : 'b' });
          }
        }
        if (row.length !== 8) throw new Error(`Invalid FEN rank ${8 - r}.`);
        return row;
      });
      this.turn = turn === 'b' ? 'b' : 'w';
      this.castling = rights === '-' ? '' : rights;
      this.enPassant = ep === '-' ? null : squareCoords(ep);
      this.halfmove = Number(halfmove);
      this.fullmove = Number(fullmove);
      this.lastMove = null;
    }

    reset() {
      this.loadFen(START_FEN);
      this.history = [];
      this.positionCounts = new Map([[this.positionKey(), 1]]);
      this.result = null;
    }

    getPiece(r, c) { return inBounds(r, c) ? this.board[r][c] : null; }
    getPieceAt(name) { const { r, c } = squareCoords(name); return this.getPiece(r, c); }
    getSymbol(piece) { return piece ? PIECES[piece.color][piece.type] : ''; }
    kingSquare(color) { for (let r = 0; r < 8; r += 1) for (let c = 0; c < 8; c += 1) { const p = this.board[r][c]; if (p?.color === color && p.type === 'k') return { r, c }; } return null; }

    isSquareAttacked(r, c, byColor) {
      const pawnDirection = byColor === 'w' ? -1 : 1;
      for (const dc of [-1, 1]) { const p = this.getPiece(r - pawnDirection, c - dc); if (p?.color === byColor && p.type === 'p') return true; }
      for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) { const p = this.getPiece(r + dr, c + dc); if (p?.color === byColor && p.type === 'n') return true; }
      for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) { const p = this.getPiece(r + dr, c + dc); if (p?.color === byColor && p.type === 'k') return true; }
      const scan = (directions, types) => {
        for (const [dr, dc] of directions) {
          let nr = r + dr; let nc = c + dc;
          while (inBounds(nr, nc)) {
            const p = this.getPiece(nr, nc);
            if (p) { if (p.color === byColor && types.includes(p.type)) return true; break; }
            nr += dr; nc += dc;
          }
        }
        return false;
      };
      return scan([[-1,0],[1,0],[0,-1],[0,1]], 'rq') || scan([[-1,-1],[-1,1],[1,-1],[1,1]], 'bq');
    }

    isInCheck(color = this.turn) { const king = this.kingSquare(color); return king ? this.isSquareAttacked(king.r, king.c, opposite(color)) : false; }

    pseudoMoves(r, c, attacksOnly = false) {
      const piece = this.getPiece(r, c);
      if (!piece) return [];
      const moves = [];
      const add = (tr, tc, extra = {}) => {
        if (!inBounds(tr, tc)) return false;
        const target = this.getPiece(tr, tc);
        if (target?.color === piece.color) return false;
        moves.push({ from: { r, c }, to: { r: tr, c: tc }, piece: { ...piece }, capture: target ? { ...target } : null, ...extra });
        return !target;
      };
      const slide = (directions) => directions.forEach(([dr, dc]) => {
        let tr = r + dr; let tc = c + dc;
        while (inBounds(tr, tc)) { if (!add(tr, tc)) break; tr += dr; tc += dc; }
      });

      if (piece.type === 'p') {
        const direction = piece.color === 'w' ? -1 : 1;
        const home = piece.color === 'w' ? 6 : 1;
        const promotionRow = piece.color === 'w' ? 0 : 7;
        if (!attacksOnly && !this.getPiece(r + direction, c)) {
          add(r + direction, c, { promotion: r + direction === promotionRow });
          if (r === home && !this.getPiece(r + direction * 2, c)) add(r + direction * 2, c, { doublePawn: true });
        }
        for (const dc of [-1, 1]) {
          const tr = r + direction; const tc = c + dc;
          if (!inBounds(tr, tc)) continue;
          const target = this.getPiece(tr, tc);
          if (attacksOnly) { moves.push({ from: { r, c }, to: { r: tr, c: tc }, piece: { ...piece } }); }
          else if (target && target.color !== piece.color) add(tr, tc, { promotion: tr === promotionRow });
          else if (this.enPassant && this.enPassant.r === tr && this.enPassant.c === tc) add(tr, tc, { enPassant: true, capture: { type: 'p', color: opposite(piece.color) } });
        }
      } else if (piece.type === 'n') {
        [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(([dr, dc]) => add(r + dr, c + dc));
      } else if (piece.type === 'b') slide([[-1,-1],[-1,1],[1,-1],[1,1]]);
      else if (piece.type === 'r') slide([[-1,0],[1,0],[0,-1],[0,1]]);
      else if (piece.type === 'q') slide([[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]);
      else if (piece.type === 'k') {
        [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]].forEach(([dr, dc]) => add(r + dr, c + dc));
        if (!attacksOnly && !this.isInCheck(piece.color)) {
          const opponent = opposite(piece.color);
          const row = piece.color === 'w' ? 7 : 0;
          const shortRight = piece.color === 'w' ? 'K' : 'k';
          const longRight = piece.color === 'w' ? 'Q' : 'q';
          const shortRook = this.getPiece(row, 7);
          const longRook = this.getPiece(row, 0);
          if (r === row && c === 4 && shortRook?.color === piece.color && shortRook.type === 'r' && this.castling.includes(shortRight) && !this.getPiece(row, 5) && !this.getPiece(row, 6) && !this.isSquareAttacked(row, 5, opponent) && !this.isSquareAttacked(row, 6, opponent)) add(row, 6, { castle: 'short' });
          if (r === row && c === 4 && longRook?.color === piece.color && longRook.type === 'r' && this.castling.includes(longRight) && !this.getPiece(row, 1) && !this.getPiece(row, 2) && !this.getPiece(row, 3) && !this.isSquareAttacked(row, 3, opponent) && !this.isSquareAttacked(row, 2, opponent)) add(row, 2, { castle: 'long' });
        }
      }
      return moves;
    }

    legalMoves(r, c) {
      const piece = this.getPiece(r, c);
      if (!piece || piece.color !== this.turn || this.result) return [];
      return this.pseudoMoves(r, c).filter(move => {
        const snapshot = this.snapshot();
        this.apply(move, { record: false });
        const legal = !this.isInCheck(piece.color);
        this.restore(snapshot);
        return legal;
      });
    }

    allLegalMoves(color = this.turn) {
      const originalTurn = this.turn; this.turn = color;
      const moves = [];
      for (let r = 0; r < 8; r += 1) for (let c = 0; c < 8; c += 1) moves.push(...this.legalMoves(r, c));
      this.turn = originalTurn;
      return moves;
    }

    snapshot() {
      return { board: cloneBoard(this.board), turn: this.turn, castling: this.castling, enPassant: this.enPassant ? { ...this.enPassant } : null, halfmove: this.halfmove, fullmove: this.fullmove, lastMove: this.lastMove ? cloneMove(this.lastMove) : null, result: this.result };
    }
    restore(snapshot) { Object.assign(this, { ...snapshot, board: cloneBoard(snapshot.board) }); }

    apply(move, options = {}) {
      const record = options.record !== false;
      const before = record ? this.snapshot() : null;
      const piece = this.board[move.from.r][move.from.c];
      if (!piece) throw new Error('No piece on the source square.');
      const captured = move.enPassant ? this.board[move.from.r][move.to.c] : this.board[move.to.r][move.to.c];
      this.board[move.from.r][move.from.c] = null;
      if (move.enPassant) this.board[move.from.r][move.to.c] = null;
      this.board[move.to.r][move.to.c] = { ...piece, type: move.promotionChoice || piece.type };
      if (move.castle === 'short') { this.board[move.from.r][5] = this.board[move.from.r][7]; this.board[move.from.r][7] = null; }
      if (move.castle === 'long') { this.board[move.from.r][3] = this.board[move.from.r][0]; this.board[move.from.r][0] = null; }
      const fromSquare = squareName(move.from.r, move.from.c); const toSquare = squareName(move.to.r, move.to.c);
      this.castling = this.castling.replace(piece.color === 'w' ? /KQ/g : /kq/g, piece.type === 'k' ? '' : '$&');
      const removeRookRight = (square, right) => { if (fromSquare === square || toSquare === square) this.castling = this.castling.replace(right, ''); };
      removeRookRight('a1', 'Q'); removeRookRight('h1', 'K'); removeRookRight('a8', 'q'); removeRookRight('h8', 'k');
      this.enPassant = move.doublePawn ? { r: (move.from.r + move.to.r) / 2, c: move.from.c } : null;
      this.halfmove = piece.type === 'p' || captured ? 0 : this.halfmove + 1;
      if (this.turn === 'b') this.fullmove += 1;
      this.lastMove = { ...cloneMove(move), piece: { ...piece }, capture: captured ? { ...captured } : null };
      this.turn = opposite(this.turn);
      // Speculative moves are used extensively while validating checks. They do
      // not need notation, and skipping it avoids recursively generating moves.
      const san = record ? this.moveToSan(this.lastMove, before) : '';
      if (record) {
        this.history.push({ before, move: this.lastMove, san, fen: this.fen() });
        const key = this.positionKey(); this.positionCounts.set(key, (this.positionCounts.get(key) || 0) + 1);
        this.updateResult();
      }
      return { move: this.lastMove, san };
    }

    moveToSan(move, before) {
      if (move.castle === 'short') return `O-O${this.isInCheck(this.turn) ? (this.allLegalMoves().length ? '+' : '#') : ''}`;
      if (move.castle === 'long') return `O-O-O${this.isInCheck(this.turn) ? (this.allLegalMoves().length ? '+' : '#') : ''}`;
      const type = move.piece.type;
      const capture = move.capture || move.enPassant;
      let notation = type === 'p' ? (capture ? FILES[move.from.c] : '') : type.toUpperCase();
      if (type !== 'p' && before) {
        const candidates = [];
        const temp = this.snapshot(); this.restore(before);
        for (let r = 0; r < 8; r += 1) for (let c = 0; c < 8; c += 1) {
          const p = this.getPiece(r, c);
          if (p?.color === move.piece.color && p.type === type && (r !== move.from.r || c !== move.from.c)) {
            if (this.legalMoves(r, c).some(m => m.to.r === move.to.r && m.to.c === move.to.c)) candidates.push({ r, c });
          }
        }
        this.restore(temp);
        if (candidates.length) {
          const sharesFile = candidates.some(p => p.c === move.from.c);
          const sharesRank = candidates.some(p => p.r === move.from.r);
          notation += sharesFile && sharesRank ? squareName(move.from.r, move.from.c) : sharesFile ? String(8 - move.from.r) : FILES[move.from.c];
        }
      }
      notation += capture ? 'x' : '';
      notation += squareName(move.to.r, move.to.c);
      if (move.promotionChoice) notation += `=${move.promotionChoice.toUpperCase()}`;
      if (this.isInCheck(this.turn)) notation += this.allLegalMoves().length ? '+' : '#';
      return notation;
    }

    undo() {
      const entry = this.history.pop();
      if (!entry) return false;
      const key = this.positionKey(); const count = this.positionCounts.get(key) || 1;
      if (count <= 1) this.positionCounts.delete(key); else this.positionCounts.set(key, count - 1);
      this.restore(entry.before);
      this.result = null;
      return true;
    }

    updateResult() {
      const moves = this.allLegalMoves();
      if (!moves.length) this.result = this.isInCheck(this.turn) ? `${this.turn === 'w' ? 'Black' : 'White'} wins by checkmate` : 'Draw by stalemate';
      else if (this.halfmove >= 100) this.result = 'Draw by fifty-move rule';
      else if (this.isInsufficientMaterial()) this.result = 'Draw by insufficient material';
      else if ((this.positionCounts.get(this.positionKey()) || 0) >= 3) this.result = 'Draw by threefold repetition';
      else this.result = null;
    }

    isInsufficientMaterial() {
      const minor = [];
      for (let r = 0; r < 8; r += 1) for (let c = 0; c < 8; c += 1) { const p = this.board[r][c]; if (p && p.type !== 'k') { if ('prq'.includes(p.type)) return false; minor.push({ ...p, r, c }); } }
      if (minor.length <= 1) return true;
      return minor.every(p => p.type === 'b') && minor.every(p => (p.r + p.c) % 2 === (minor[0].r + minor[0].c) % 2);
    }

    fen() {
      const placement = this.board.map(row => { let out = ''; let empty = 0; row.forEach(piece => { if (!piece) empty += 1; else { if (empty) out += empty; empty = 0; out += piece.color === 'w' ? piece.type.toUpperCase() : piece.type; } }); return out + (empty || ''); }).join('/');
      return `${placement} ${this.turn} ${this.castling || '-'} ${this.enPassant ? squareName(this.enPassant.r, this.enPassant.c) : '-'} ${this.halfmove} ${this.fullmove}`;
    }
    positionKey() { return this.fen().split(' ').slice(0, 4).join(' '); }
    pgn() {
      const chunks = [];
      this.history.forEach((entry, index) => { if (index % 2 === 0) chunks.push(`${Math.floor(index / 2) + 1}.`); chunks.push(entry.san); });
      const result = this.result?.includes('White wins') ? '1-0' : this.result?.includes('Black wins') ? '0-1' : this.result?.startsWith('Draw') ? '1/2-1/2' : '*';
      return `[Event "Tournament Room Practice"]\n[Site "Local"]\n[Date "${new Date().toISOString().slice(0, 10).replaceAll('-', '.')}"]\n[Result "${result}"]\n\n${chunks.join(' ')} ${result}`;
    }
    moveFromUci(uci) {
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
      const from = squareCoords(uci.slice(0, 2)); const to = squareCoords(uci.slice(2, 4));
      const move = this.legalMoves(from.r, from.c).find(m => m.to.r === to.r && m.to.c === to.c);
      return move ? { ...move, promotionChoice: uci[4] || undefined } : null;
    }
  }

  window.ChessDomain = { ChessGame, START_FEN, FILES, squareName, squareCoords, opposite };
})();
