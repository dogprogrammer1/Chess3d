/* DOM-backed 3D board renderer. CSS perspective keeps interaction accessible
 * while the renderer remains replaceable by a future WebGL scene. */
(function () {
  'use strict';
  const { FILES, squareName } = window.ChessDomain;

  class BoardRenderer {
    constructor(element, onSquareClick) {
      this.element = element;
      this.onSquareClick = onSquareClick;
      this.orientation = 'w';
      this.selected = null;
      this.legalMoves = [];
      this.game = null;
      this.dragStart = null;
    }
    setOrientation(color) { this.orientation = color; this.render(); }
    setSelection(square, moves) { this.selected = square; this.legalMoves = moves || []; this.render(); }
    clearSelection() { this.setSelection(null, []); }
    setGame(game) { this.game = game; this.render(); }

    render() {
      if (!this.game) return;
      const board = this.element;
      board.replaceChildren();
      const ranks = this.orientation === 'w' ? [0,1,2,3,4,5,6,7] : [7,6,5,4,3,2,1,0];
      const files = this.orientation === 'w' ? [0,1,2,3,4,5,6,7] : [7,6,5,4,3,2,1,0];
      const legalByTarget = new Map(this.legalMoves.map(move => [`${move.to.r},${move.to.c}`, move]));
      const checkKing = this.game.isInCheck() ? this.game.kingSquare(this.game.turn) : null;
      ranks.forEach((r, visualR) => files.forEach((c, visualC) => {
        const piece = this.game.getPiece(r, c);
        const square = document.createElement('button');
        square.type = 'button';
        square.className = `square ${(r + c) % 2 ? 'dark' : 'light'}`;
        square.dataset.rank = r; square.dataset.file = c;
        square.setAttribute('role', 'gridcell');
        square.setAttribute('aria-label', `${squareName(r, c)}${piece ? `, ${piece.color === 'w' ? 'white' : 'black'} ${this.pieceName(piece.type)}` : ', empty'}`);
        if (this.selected?.r === r && this.selected?.c === c) square.classList.add('selected');
        if (this.game.lastMove && ((this.game.lastMove.from.r === r && this.game.lastMove.from.c === c) || (this.game.lastMove.to.r === r && this.game.lastMove.to.c === c))) square.classList.add('last-move');
        if (checkKing?.r === r && checkKing?.c === c) square.classList.add('in-check');
        const targetMove = legalByTarget.get(`${r},${c}`);
        if (targetMove) {
          square.classList.add('legal');
          if (targetMove.capture || targetMove.enPassant) square.classList.add('capture');
        }
        if (visualC === 0) square.append(this.label(String(8 - r), 'rank-label'));
        if (visualR === 7) square.append(this.label(FILES[c], 'file-label'));
        if (piece) {
          const token = document.createElement('span');
          token.className = `piece ${piece.color === 'w' ? 'white' : 'black'}`;
          token.textContent = this.game.getSymbol(piece);
          token.setAttribute('aria-hidden', 'true');
          square.append(token);
        }
        square.addEventListener('pointerdown', event => {
          if (event.button !== undefined && event.button !== 0) return;
          this.dragStart = { r, c };
        });
        square.addEventListener('pointerup', event => {
          if (event.button !== undefined && event.button !== 0) return;
          event.preventDefault();
          const start = this.dragStart;
          this.dragStart = null;
          const hitSquare = document.elementFromPoint(event.clientX, event.clientY)?.closest('.square');
          const destination = hitSquare
            ? { r: Number(hitSquare.dataset.rank), c: Number(hitSquare.dataset.file) }
            : { r, c };
          // A short tap selects/moves; dragging directly from one square to
          // another also works, without requiring a pixel-perfect piece click.
          if (start && (start.r !== destination.r || start.c !== destination.c)) {
            this.onSquareClick(start);
            this.onSquareClick(destination);
          } else {
            this.onSquareClick(destination);
          }
        });
        square.addEventListener('click', event => {
          // Pointer activation is handled above. Keep keyboard activation
          // accessible without making a mouse/touch action fire twice.
          if (event.detail === 0) this.onSquareClick({ r, c });
        });
        board.append(square);
      }));
    }
    label(text, className) { const label = document.createElement('span'); label.className = `coordinate ${className}`; label.textContent = text; return label; }
    pieceName(type) { return ({ p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' })[type]; }
  }
  window.TournamentRenderer = { BoardRenderer };
})();
