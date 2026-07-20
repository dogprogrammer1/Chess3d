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
    }
    setOrientation(color) { this.orientation = color; this.render(); }
    setSelection(square, moves) { this.selected = square; this.legalMoves = moves || []; this.render(); }
    clearSelection() { this.setSelection(null, []); }
    setGame(game) { this.game = game; this.render(); }
    setCamera(camera) { this.solidScene?.setCamera(camera); }
    setTournamentController(controller) {
      this.tournamentController = controller;
      this.cancelTournamentDrag();
    }
    cancelTournamentDrag() {
      this.draggingTournamentPiece = false;
      this.solidScene?.clearDragPiece();
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
      this.element.setAttribute('aria-label', `${turn} to move on the interactive 3D chess board.`);
      this.solidScene?.setPosition(this.game, this.orientation, this.selected, this.legalMoves);
    }
  }
  window.TournamentRenderer = { BoardRenderer };
})();
