(function () {
  'use strict';

  const { ChessGame, squareName } = window.ChessDomain;
  const { BoardRenderer } = window.TournamentRenderer;
  const { GameStorage } = window.TournamentStorage;
  const { StockfishClient } = window.TournamentEngine;
  const { CustomChessEngine } = window.TournamentCustomEngine;

  const $ = id => document.getElementById(id);
  const ui = {
    board: $('chessboard'), boardWrap: $('board-wrap'), title: $('game-title'), turn: $('turn-indicator'), hint: $('board-hint'),
    newGame: $('new-game'), undo: $('undo-move'), flip: $('flip-board'), gameMode: $('game-mode'), engineSelect: $('engine-select'), depth: $('engine-depth'), depthValue: $('depth-value'), opponentDescription: $('opponent-description'), selectedEngineName: $('selected-engine-name'), selectedEngineStats: $('selected-engine-stats'),
    camera: $('camera-tilt'), resetCamera: $('reset-camera'), save: $('save-game'), moveList: $('move-list'), copyPgn: $('copy-pgn'), copyFen: $('copy-fen'), fen: $('fen-value'),
    connect: $('connect-engine'), engineDot: $('engine-dot'), engineLabel: $('engine-label'), engineMessage: $('engine-message'), evalScore: $('eval-score'), evalMeter: $('eval-meter-fill'), pv: $('pv-line'),
    promotion: $('promotion-dialog'), promotionOptions: $('promotion-options'), toast: $('toast'),
  };

  class TournamentRoom {
    constructor() {
      this.game = new ChessGame();
      this.storage = new GameStorage();
      this.engine = new StockfishClient();
      this.customEngine = new CustomChessEngine();
      this.selected = null;
      this.selectionMoves = [];
      this.orientation = 'w';
      this.pendingPromotion = null;
      this.engineThinking = false;
      this.engineRequestToken = 0;
      this.depthSettings = { stockfish: 14, custom: 4 };
      this.lastEngineStats = '';
      this.cameraState = { pitch: 54, yaw: 0, panX: 0, panY: 0, zoom: 1, pressed: new Set(), frame: null };
      this.renderer = new BoardRenderer(ui.board, square => this.handleSquare(square));
      this.bindEvents();
      this.bindEngine();
      this.restoreLocalSession();
      this.setEngineControls();
      this.applyCamera();
      this.render();
    }

    bindEvents() {
      ui.newGame.addEventListener('click', () => this.newGame());
      ui.undo.addEventListener('click', () => this.undo());
      ui.flip.addEventListener('click', () => { this.orientation = this.orientation === 'w' ? 'b' : 'w'; this.renderer.setOrientation(this.orientation); });
      ui.gameMode.addEventListener('change', () => { this.customEngine.cancel(); this.engineRequestToken += 1; this.engineThinking = false; this.setEngineControls(); this.render(); this.analyse(); this.maybeEngineTurn(); });
      ui.engineSelect.addEventListener('change', () => { this.customEngine.cancel(); this.engineRequestToken += 1; this.engineThinking = false; this.lastEngineStats = ''; this.setEngineControls(); this.render(); this.analyse(); this.maybeEngineTurn(); });
      ui.depth.addEventListener('input', () => this.updateDepth());
      ui.camera.addEventListener('input', () => { this.cameraState.pitch = Number(ui.camera.value); this.applyCamera(); });
      ui.resetCamera.addEventListener('click', () => this.resetCamera());
      ui.save.addEventListener('click', () => this.save());
      ui.copyPgn.addEventListener('click', () => this.copy(this.game.pgn(), 'PGN copied.'));
      ui.copyFen.addEventListener('click', () => this.copy(this.game.fen(), 'FEN copied.'));
      ui.connect.addEventListener('click', () => this.connectEngine());
      window.addEventListener('keydown', event => this.handleCameraKey(event, true));
      window.addEventListener('keyup', event => this.handleCameraKey(event, false));
      window.addEventListener('blur', () => { this.cameraState.pressed.clear(); });
    }

    bindEngine() {
      this.engine.onStatus((status, detail) => {
        if (this.engineKind() === 'custom') return;
        ui.engineDot.className = `engine-dot ${status === 'online' ? 'online' : status === 'connecting' ? 'connecting' : 'offline'}`;
        ui.engineDot.title = status === 'online' ? 'Stockfish connected' : status === 'connecting' ? 'Connecting to Stockfish' : 'Stockfish offline';
        if (status === 'connecting') { ui.engineMessage.textContent = 'Looking for the local Stockfish bridge…'; ui.connect.disabled = true; ui.connect.textContent = 'Connecting…'; }
        if (status === 'online') { ui.engineMessage.textContent = detail || 'Connected locally. Evaluation updates after each move.'; ui.connect.disabled = false; ui.connect.textContent = 'Engine connected'; }
        if (status === 'offline') { ui.engineMessage.textContent = detail || 'Engine offline. Start the local bridge to analyse this board.'; ui.connect.disabled = false; ui.connect.textContent = 'Connect engine'; this.engineThinking = false; }
      });
      this.engine.onAnalysis = message => {
        if (this.engineKind() === 'custom') return;
        if (message.fen !== this.game.fen()) return;
        const whiteScore = this.game.turn === 'w' ? Number(message.score) : -Number(message.score);
        const display = message.scoreType === 'mate' ? `M${whiteScore > 0 ? '+' : ''}${whiteScore}` : `${whiteScore >= 0 ? '+' : ''}${(whiteScore / 100).toFixed(2)}`;
        this.lastEngineStats = `${Number(message.nodes || 0).toLocaleString()} nodes · depth ${message.depth || ui.depth.value}`;
        this.refreshEngineProfile();
        ui.evalScore.textContent = display;
        const normalized = message.scoreType === 'mate' ? (whiteScore > 0 ? 1000 : -1000) : whiteScore;
        ui.evalMeter.style.width = `${Math.max(4, Math.min(96, 50 + normalized / 24))}%`;
        ui.pv.textContent = message.pv || 'No principal variation returned.';
        ui.engineMessage.textContent = `Depth ${message.depth || ui.depth.value} · ${message.nodes ? `${Number(message.nodes).toLocaleString()} nodes` : 'ready'}`;
      };
      this.engine.onBestMove = message => {
        if (this.engineKind() !== 'stockfish' || !this.engineThinking || message.fen !== this.game.fen()) return;
        this.engineThinking = false;
        const move = this.game.moveFromUci(message.move);
        if (!move) { this.showToast('Stockfish returned an invalid move for this position.'); return; }
        this.commitMove(move, true);
      };
    }

    restoreLocalSession() {
      const session = this.storage.loadSession();
      if (!session) return;
      try {
        this.game = new ChessGame(session.fen);
        // A stored PGN remains available through Save; restoring the FEN gives a
        // reliable, compact resume point even after browser updates.
        if (session.settings?.mode) {
          // Migrate saves made before engine selection became independent from
          // the side-selection menu.
          if (session.settings.mode.startsWith('custom-')) {
            ui.gameMode.value = session.settings.mode.endsWith('white') ? 'engine-white' : 'engine-black';
            ui.engineSelect.value = 'custom';
          } else {
            ui.gameMode.value = session.settings.mode;
          }
        }
        if (session.settings?.engine && ['stockfish', 'custom'].includes(session.settings.engine)) ui.engineSelect.value = session.settings.engine;
        if (session.settings?.depth) {
          const key = ui.gameMode.value.startsWith('custom') ? 'custom' : 'stockfish';
          this.depthSettings[key] = Number(session.settings.depth);
        }
        this.showToast('Restored your last local position.');
      } catch { localStorage.removeItem('tournament-room.session.v1'); }
    }

    engineKind() { return ui.engineSelect.value; }
    engineColor() {
      if (ui.gameMode.value === 'analysis') return null;
      return ui.gameMode.value.endsWith('white') ? 'w' : 'b';
    }
    engineName() { return this.engineKind() === 'custom' ? 'CustomChessEngine' : 'Stockfish'; }
    opponentName() { return this.engineName(); }
    refreshEngineProfile() {
      const custom = this.engineKind() === 'custom';
      const depth = ui.depth.value;
      ui.selectedEngineName.textContent = this.engineName();
      const base = custom
        ? `Classical evaluation · aggressive · about 1900 · depth ${depth}`
        : `Local UCI bridge · tournament engine · depth ${depth}`;
      ui.selectedEngineStats.textContent = this.lastEngineStats ? `${base} · ${this.lastEngineStats}` : base;
    }

    setEngineControls() {
      {
        const custom = this.engineKind() === 'custom';
        const key = custom ? 'custom' : 'stockfish';
        const minDepth = custom ? 1 : 2;
        // The original browser engine's branching factor rises sharply above
        // depth 4. Keeping in-app play at this tested ceiling prevents the
        // browser from terminating a long-running worker.
        const maxDepth = custom ? 4 : 20;
        const depth = Math.max(minDepth, Math.min(maxDepth, this.depthSettings[key]));
        ui.depth.min = String(minDepth);
        ui.depth.max = String(maxDepth);
        ui.depth.value = String(depth);
        ui.depthValue.textContent = String(depth);
        this.refreshEngineProfile();

        ui.engineLabel.textContent = this.engineName();
        if (custom) {
          ui.opponentDescription.textContent = ui.gameMode.value === 'analysis'
            ? 'Use CustomChessEngine for local classical analysis.'
            : 'CustomChessEngine plays aggressively at the chosen search depth.';
          ui.engineDot.className = 'engine-dot online';
          ui.engineDot.title = 'CustomChessEngine ready';
          ui.engineMessage.textContent = 'Classical evaluation · aggressive style · approximately 1900 strength.';
          ui.pv.textContent = 'The custom engine searches locally in the browser.';
          ui.connect.disabled = true;
          ui.connect.textContent = 'CustomChessEngine ready';
        } else {
          ui.opponentDescription.textContent = ui.gameMode.value === 'analysis'
            ? 'Use Stockfish for local position analysis.'
            : 'Stockfish plays the selected colour at the chosen search depth.';
          ui.engineDot.className = `engine-dot ${this.engine.status === 'online' ? 'online' : this.engine.status === 'connecting' ? 'connecting' : 'offline'}`;
          ui.engineDot.title = this.engine.status === 'online' ? 'Stockfish connected' : this.engine.status === 'connecting' ? 'Connecting to Stockfish' : 'Stockfish offline';
          ui.connect.disabled = this.engine.status === 'connecting';
          ui.connect.textContent = this.engine.status === 'online' ? 'Engine connected' : this.engine.status === 'connecting' ? 'Connecting…' : 'Connect engine';
          if (this.engine.status === 'online') ui.engineMessage.textContent = 'Connected locally. Evaluation updates after each move.';
          if (this.engine.status !== 'online') ui.engineMessage.textContent = 'Engine offline. Start the local bridge to analyse this board.';
        }
        return;
      }
      const custom = this.engineKind() === 'custom';
      const presets = custom
        ? [[1, 'Relaxed · Depth 1'], [3, 'Casual · Depth 3'], [4, 'Club · Depth 4'], [6, 'Aggressive · ~1900'], [8, 'Expert · Depth 8'], [10, 'Maximum · Depth 10']]
        : [[4, 'Beginner · Depth 4'], [8, 'Club · Depth 8'], [14, 'Tournament · Depth 14'], [18, 'Expert · Depth 18']];
      const depth = Math.max(custom ? 1 : 2, Math.min(custom ? 10 : 20, this.depthSettings[custom ? 'custom' : 'stockfish']));
      ui.depth.min = custom ? '1' : '2';
      ui.depth.max = custom ? '10' : '20';
      ui.depth.value = String(depth);
      ui.depthValue.textContent = String(depth);
      ui.strength.replaceChildren();
      presets.forEach(([value, label]) => {
        const option = document.createElement('option'); option.value = String(value); option.textContent = label;
        if (value === depth) option.selected = true;
        ui.strength.append(option);
      });
      const manual = document.createElement('option'); manual.value = 'custom'; manual.textContent = 'Custom depth';
      ui.strength.append(manual);
      if (!presets.some(([value]) => value === depth)) ui.strength.value = 'custom';
      if (custom) {
        ui.opponentDescription.textContent = 'Custom engine · aggressive tactical play · approximately 1900 strength.';
        ui.engineLabel.textContent = 'Custom engine';
        ui.engineDot.className = 'engine-dot online';
        ui.engineDot.title = 'Custom engine ready';
        ui.engineMessage.textContent = 'Aggressive tactical play, adapted from your CustomChessEngine for this board.';
        ui.pv.textContent = 'The custom engine searches locally in the browser.';
        ui.connect.disabled = true;
        ui.connect.textContent = 'Custom engine ready';
      } else {
        ui.opponentDescription.textContent = ui.gameMode.value === 'analysis' ? 'Use Stockfish for local position analysis.' : 'Stockfish plays the selected colour at the chosen search depth.';
        ui.engineLabel.textContent = 'Stockfish';
        ui.engineDot.className = `engine-dot ${this.engine.status === 'online' ? 'online' : this.engine.status === 'connecting' ? 'connecting' : 'offline'}`;
        ui.engineDot.title = this.engine.status === 'online' ? 'Stockfish connected' : this.engine.status === 'connecting' ? 'Connecting to Stockfish' : 'Stockfish offline';
        ui.connect.disabled = this.engine.status === 'connecting';
        ui.connect.textContent = this.engine.status === 'online' ? 'Engine connected' : this.engine.status === 'connecting' ? 'Connecting…' : 'Connect engine';
        if (this.engine.status !== 'online') ui.engineMessage.textContent = 'Engine offline. Start the local bridge to analyse this board.';
      }
    }

    updateDepth() {
      const key = this.engineKind() === 'custom' ? 'custom' : 'stockfish';
      const depth = Math.max(Number(ui.depth.min), Math.min(Number(ui.depth.max), Number(ui.depth.value)));
      this.depthSettings[key] = depth;
      ui.depth.value = String(depth);
      ui.depthValue.textContent = String(depth);
      this.lastEngineStats = '';
      this.refreshEngineProfile();
      this.analyse();
    }

    handleCameraKey(event, isDown) {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || ui.promotion.open) return;
      const keys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyI', 'KeyJ', 'KeyK', 'KeyL', 'Space', 'ShiftLeft', 'ShiftRight']);
      if (!keys.has(event.code)) return;
      event.preventDefault();
      if (isDown) this.cameraState.pressed.add(event.code); else this.cameraState.pressed.delete(event.code);
      if (isDown && !this.cameraState.frame) this.cameraState.frame = requestAnimationFrame(() => this.advanceCamera());
    }

    advanceCamera() {
      const keys = this.cameraState.pressed;
      const state = this.cameraState;
      if (keys.has('KeyW')) state.panY = Math.max(-92, state.panY - 2.4);
      if (keys.has('KeyS')) state.panY = Math.min(92, state.panY + 2.4);
      if (keys.has('KeyA')) state.panX = Math.max(-105, state.panX - 2.4);
      if (keys.has('KeyD')) state.panX = Math.min(105, state.panX + 2.4);
      if (keys.has('Space')) state.zoom = Math.min(1.22, state.zoom + .012);
      if (keys.has('ShiftLeft') || keys.has('ShiftRight')) state.zoom = Math.max(.78, state.zoom - .012);
      if (keys.has('KeyI')) state.pitch = Math.min(72, state.pitch + .42);
      if (keys.has('KeyK')) state.pitch = Math.max(32, state.pitch - .42);
      if (keys.has('KeyJ')) state.yaw = Math.max(-28, state.yaw - .55);
      if (keys.has('KeyL')) state.yaw = Math.min(28, state.yaw + .55);
      this.applyCamera();
      state.frame = keys.size ? requestAnimationFrame(() => this.advanceCamera()) : null;
    }

    applyCamera() {
      ui.camera.value = String(this.cameraState.pitch);
      document.documentElement.style.setProperty('--camera-tilt', `${this.cameraState.pitch}deg`);
      document.documentElement.style.setProperty('--camera-yaw', `${this.cameraState.yaw}deg`);
      document.documentElement.style.setProperty('--camera-pan-x', `${this.cameraState.panX}px`);
      document.documentElement.style.setProperty('--camera-pan-y', `${this.cameraState.panY}px`);
      document.documentElement.style.setProperty('--camera-zoom', String(this.cameraState.zoom));
    }

    resetCamera() {
      Object.assign(this.cameraState, { pitch: 54, yaw: 0, panX: 0, panY: 0, zoom: 1 });
      this.applyCamera();
    }

    handleSquare(square) {
      if (this.engineThinking || this.pendingPromotion || this.game.result) return;
      const target = this.selectionMoves.find(move => move.to.r === square.r && move.to.c === square.c);
      if (this.selected && target) {
        if (target.promotion) this.openPromotion(target);
        else this.commitMove(target);
        return;
      }
      const piece = this.game.getPiece(square.r, square.c);
      if (piece?.color === this.game.turn) {
        this.selected = square;
        this.selectionMoves = this.game.legalMoves(square.r, square.c);
        this.renderer.setSelection(this.selected, this.selectionMoves);
        ui.hint.textContent = this.selectionMoves.length ? `${this.selectionMoves.length} legal move${this.selectionMoves.length === 1 ? '' : 's'} for ${squareName(square.r, square.c)}.` : 'This piece has no legal moves.';
      } else {
        this.clearSelection();
      }
    }

    openPromotion(move) {
      this.pendingPromotion = move;
      ui.promotionOptions.replaceChildren();
      const color = move.piece.color;
      const pieces = { q: color === 'w' ? '♕' : '♛', r: color === 'w' ? '♖' : '♜', b: color === 'w' ? '♗' : '♝', n: color === 'w' ? '♘' : '♞' };
      Object.entries(pieces).forEach(([type, symbol]) => {
        const button = document.createElement('button'); button.className = 'promotion-choice'; button.type = 'button'; button.textContent = symbol;
        button.setAttribute('aria-label', `Promote to ${({ q: 'queen', r: 'rook', b: 'bishop', n: 'knight' })[type]}`);
        button.addEventListener('click', () => { ui.promotion.close(); const promotion = { ...this.pendingPromotion, promotionChoice: type }; this.pendingPromotion = null; this.commitMove(promotion); });
        ui.promotionOptions.append(button);
      });
      ui.promotion.showModal();
    }

    commitMove(move, fromEngine = false) {
      const { san } = this.game.apply(move);
      this.clearSelection(false);
      this.render();
      if (this.game.result) { this.showToast(this.game.result); ui.hint.textContent = this.game.result; }
      else { ui.hint.textContent = fromEngine ? `${this.opponentName()} played ${san}.` : `${san} recorded. ${this.game.turn === 'w' ? 'White' : 'Black'} to move.`; }
      this.analyse();
      this.maybeEngineTurn();
    }

    maybeEngineTurn() {
      const engineColor = this.engineColor();
      const kind = this.engineKind();
      if (!engineColor || engineColor !== this.game.turn || this.game.result) return;
      if (kind === 'stockfish' && this.engine.status !== 'online') return;
      this.engineThinking = true;
      const token = ++this.engineRequestToken;
      const fen = this.game.fen();
      ui.hint.textContent = `${this.opponentName()} is considering the position…`;
      if (kind === 'custom') {
        this.customEngine.chooseMove(this.game, Number(ui.depth.value)).then(result => {
          if (!result || token !== this.engineRequestToken || !this.engineThinking || this.game.fen() !== fen) return;
          this.engineThinking = false;
          const move = this.game.moveFromUci(result.move);
          if (!move) { this.showToast('Custom engine could not resolve a legal move.'); return; }
          this.lastEngineStats = `${Number(result.nodes).toLocaleString()} nodes · ${Math.round(result.elapsedMs)} ms`;
          this.refreshEngineProfile();
          // The custom classical evaluator always reports a White-relative
          // score, irrespective of which side the engine is playing.
          const whiteScore = result.score;
          ui.evalScore.textContent = `${whiteScore >= 0 ? '+' : ''}${(whiteScore / 100).toFixed(2)}`;
          ui.evalMeter.style.width = `${Math.max(4, Math.min(96, 50 + whiteScore / 24))}%`;
          ui.pv.textContent = `${result.style} · depth ${result.depth} · ${Number(result.nodes).toLocaleString()} nodes`;
          this.commitMove(move, true);
        }).catch(error => {
          if (token !== this.engineRequestToken) return;
          this.engineThinking = false;
          this.showToast(error?.message || 'CustomChessEngine could not complete this search.');
        });
      } else {
        this.engine.requestMove(fen, Number(ui.depth.value));
      }
    }

    newGame() {
      this.customEngine.cancel();
      this.engineRequestToken += 1;
      this.game.reset(); this.selected = null; this.selectionMoves = []; this.engineThinking = false;
      this.render();
      ui.hint.textContent = 'New practice board ready. White to move.';
      if (this.engineKind() === 'custom') {
        ui.evalScore.textContent = '—';
        ui.evalMeter.style.width = '50%';
        ui.pv.textContent = 'The custom engine searches locally in the browser.';
      }
      this.showToast('New practice board ready.'); this.analyse(); this.maybeEngineTurn();
    }
    undo() {
      if (this.engineThinking) return;
      if (!this.game.undo()) { this.showToast('There is no move to take back.'); return; }
      const engineColor = this.engineColor();
      if (engineColor && this.game.history.length && this.game.turn === engineColor) this.game.undo();
      this.clearSelection(false); this.render(); this.analyse(); this.showToast('Move taken back.');
    }
    clearSelection(render = true) {
      this.selected = null;
      this.selectionMoves = [];
      // Keep the UI selection state in lock-step with the game state even
      // when a render is queued immediately afterwards (move, undo, new game).
      this.renderer.selected = null;
      this.renderer.legalMoves = [];
      if (render) this.renderer.render();
    }
    analyse() { if (this.engineKind() !== 'custom' && this.engine.status === 'online') this.engine.analyse(this.game.fen(), Number(ui.depth.value)); }
    connectEngine() {
      if (this.engineKind() === 'custom') { this.showToast('The custom engine runs locally in this browser.'); return; }
      this.engine.connect().then(() => { this.analyse(); this.maybeEngineTurn(); }).catch(() => this.showToast('Bridge unavailable. See the setup guide.'));
    }

    render() { this.renderer.setGame(this.game); this.renderHeader(); this.renderMoves(); ui.fen.textContent = this.game.fen(); }
    renderHeader() {
      {
        const modeLabel = ui.gameMode.value === 'analysis'
          ? 'Analysis board'
          : `Vs. ${this.engineName()} · ${this.engineColor() === 'w' ? 'White' : 'Black'}`;
        ui.title.textContent = this.game.result || modeLabel;
        ui.turn.innerHTML = `<span class="turn-piece ${this.game.turn === 'w' ? 'white-piece' : 'black-piece'}">${this.game.turn === 'w' ? '♔' : '♚'}</span><span>${this.game.result || `${this.game.turn === 'w' ? 'White' : 'Black'} to move`}</span>`;
        return;
      }
      const modeLabel = ({ analysis: 'Analysis board', 'engine-black': 'Vs. Stockfish · Black', 'engine-white': 'Vs. Stockfish · White', 'custom-black': 'Vs. Custom engine · Black', 'custom-white': 'Vs. Custom engine · White' })[ui.gameMode.value];
      ui.title.textContent = this.game.result || modeLabel;
      ui.turn.innerHTML = `<span class="turn-piece ${this.game.turn === 'w' ? 'white-piece' : 'black-piece'}">${this.game.turn === 'w' ? '♔' : '♚'}</span><span>${this.game.result || `${this.game.turn === 'w' ? 'White' : 'Black'} to move`}</span>`;
    }
    renderMoves() {
      if (!this.game.history.length) { ui.moveList.innerHTML = '<p class="empty-moves">Your moves will be recorded here.</p>'; return; }
      ui.moveList.replaceChildren();
      for (let i = 0; i < this.game.history.length; i += 2) {
        const row = document.createElement('div'); row.className = 'move-row';
        const number = document.createElement('span'); number.className = 'move-number'; number.textContent = `${Math.floor(i / 2) + 1}.`;
        const white = document.createElement('span'); white.className = `move-san ${i === this.game.history.length - 1 ? 'latest' : ''}`; white.textContent = this.game.history[i]?.san || '';
        const black = document.createElement('span'); black.className = `move-san ${i + 1 === this.game.history.length - 1 ? 'latest' : ''}`; black.textContent = this.game.history[i + 1]?.san || '';
        row.append(number, white, black); ui.moveList.append(row);
      }
      ui.moveList.scrollTop = ui.moveList.scrollHeight;
    }
    save() {
      this.storage.saveSession(this.game, { mode: ui.gameMode.value, engine: ui.engineSelect.value, depth: ui.depth.value });
      this.storage.downloadPgn(this.game);
      this.showToast('Saved locally and exported as a PGN file.');
    }
    async copy(value, message) {
      try { await navigator.clipboard.writeText(value); }
      catch { const field = document.createElement('textarea'); field.value = value; document.body.append(field); field.select(); document.execCommand('copy'); field.remove(); }
      this.showToast(message);
    }
    showToast(message) { clearTimeout(this.toastTimer); ui.toast.textContent = message; ui.toast.classList.add('show'); this.toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 3000); }
  }

  window.addEventListener('DOMContentLoaded', () => { window.tournamentRoom = new TournamentRoom(); });
})();
