/* Input coordinator for the single-canvas WebGL chess board. */
(function () {
  'use strict';

  class BoardRenderer {
    constructor(element, onSquareClick) {
      this.element = element;
      this.onSquareClick = onSquareClick;
      this.orientation = 'w';
      this.selected = null;
      this.legalMoves = [];
      this.game = null;
      this.dragStart = null;
      this.tournamentController = null;
      this.draggingTournamentPiece = false;
      this.solidScene = window.TournamentSolidBoard ? new window.TournamentSolidBoard.SolidBoardScene(element) : null;
      if (this.solidScene?.available) this.bindSolidPointerEvents();
      else this.createFlatBoard();
    }
    setOrientation(color) { this.orientation = color; this.render(); }
    setSelection(square, moves) { this.selected = square; this.legalMoves = moves || []; this.render(); }
    clearSelection() { this.setSelection(null, []); }
    setGame(game) { this.game = game; this.render(); }
    setCamera(camera) { this.solidScene?.setCamera(camera); }
    focus() { (this.focusedSquare || this.element).focus({ preventScroll: true }); }
    setTournamentController(controller) {
      this.tournamentController = controller;
      this.cancelTournamentDrag();
    }
    cancelTournamentDrag() {
      this.draggingTournamentPiece = false;
      this.solidScene?.clearDragPiece();
    }

    createFlatBoard() {
      const grid = document.createElement('div');
      grid.className = 'flat-board';
      grid.tabIndex = -1;
      grid.setAttribute('role', 'group');
      for (let index = 0; index < 64; index++) {
        const button = document.createElement('button');
        button.type = 'button';
        button.tabIndex = index === 0 ? 0 : -1;
        button.className = (Math.floor(index / 8) + index % 8) % 2 ? 'dark' : 'light';
        button.addEventListener('click', () => {
          const square = this.flatSquare(index);
          if (!this.tournamentController?.isActive()) this.onSquareClick(square);
          else if (this.selected) this.tournamentController.drop(square);
          else this.tournamentController.beginDrag(square);
        });
        button.addEventListener('focus', () => {
          this.focusedSquare.tabIndex = -1;
          button.tabIndex = 0;
          this.focusedSquare = button;
        });
        button.addEventListener('keydown', event => {
          const row = Math.floor(index / 8), col = index % 8;
          const next = { ArrowUp: [row - 1, col], ArrowDown: [row + 1, col], ArrowLeft: [row, col - 1], ArrowRight: [row, col + 1] }[event.key];
          if (!next) return;
          event.preventDefault();
          if (next.every(value => value >= 0 && value < 8)) grid.children[next[0] * 8 + next[1]].focus();
        });
        grid.append(button);
      }
      this.focusedSquare = grid.children[0];
      this.element.parentElement.classList.add('flat-board-active');
      this.element.replaceWith(grid);
      this.element = grid;
    }

    flatSquare(index) {
      const square = this.orientation === 'w' ? index : 63 - index;
      return { r: Math.floor(square / 8), c: square % 8 };
    }

    renderFlatBoard() {
      const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
      const { squareName } = window.ChessDomain;
      const targets = new Set(this.legalMoves.map(move => squareName(move.to.r, move.to.c)));
      Array.from(this.element.children).forEach((button, index) => {
        const { r, c } = this.flatSquare(index);
        const name = squareName(r, c);
        const piece = this.game.getPiece(r, c);
        const selected = this.selected?.r === r && this.selected.c === c;
        const occupant = piece ? `${piece.color === 'w' ? 'White' : 'Black'} ${names[piece.type]}` : 'empty';
        button.textContent = this.game.getSymbol(piece);
        button.dataset.color = piece?.color || '';
        button.classList.toggle('legal', targets.has(name));
        button.setAttribute('aria-pressed', String(selected));
        button.setAttribute('aria-label', `${name}, ${occupant}${targets.has(name) ? ', legal move' : ''}`);
      });
    }

    bindSolidPointerEvents() {
      const canvas = this.solidScene.canvas;
      canvas.addEventListener('pointerdown', event => {
        if (event.button !== undefined && event.button !== 0) return;
        const square = this.solidScene.pickSquare(event.clientX, event.clientY);
        if (this.tournamentController?.isActive?.()) {
          const drag = this.tournamentController.beginDrag(square);
          if (!drag) return;
          this.dragStart = drag.from;
          this.draggingTournamentPiece = true;
          this.solidScene.setDragPiece(drag.piece, drag.from);
          this.solidScene.updateDragFromPointer(event.clientX, event.clientY);
        } else {
          this.dragStart = square;
        }
        if (this.dragStart) canvas.setPointerCapture?.(event.pointerId);
      });
      canvas.addEventListener('pointermove', event => {
        if (this.draggingTournamentPiece) this.solidScene.updateDragFromPointer(event.clientX, event.clientY);
      });
      canvas.addEventListener('pointerup', event => {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        const start = this.dragStart;
        const destination = this.solidScene.pickSquare(event.clientX, event.clientY);
        this.dragStart = null;
        if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        if (this.tournamentController?.isActive?.()) {
          const wasDragging = this.draggingTournamentPiece;
          this.cancelTournamentDrag();
          if (wasDragging) this.tournamentController.drop(destination, start);
          return;
        }
        if (!destination) return;
        if (start && (start.r !== destination.r || start.c !== destination.c)) {
          this.onSquareClick(start);
          this.onSquareClick(destination);
        } else {
          this.onSquareClick(destination);
        }
      });
      canvas.addEventListener('pointercancel', () => { this.dragStart = null; this.cancelTournamentDrag(); });
    }

    render() {
      if (!this.game) return;
      const turn = this.game.turn === 'w' ? 'White' : 'Black';
      this.element.setAttribute('aria-label', `${turn} to move on the chessboard.`);
      if (this.solidScene?.available) this.solidScene.setPosition(this.game, this.orientation, this.selected, this.legalMoves);
      else this.renderFlatBoard();
    }
  }
  window.TournamentRenderer = { BoardRenderer };
})();
