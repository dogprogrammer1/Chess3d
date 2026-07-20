(function () {
  'use strict';

  const { ChessGame, squareName } = window.ChessDomain;
  const { BoardRenderer } = window.TournamentRenderer;
  const { GameStorage } = window.TournamentStorage;
  const { StockfishClient } = window.TournamentEngine;
  const { CustomChessEngine } = window.TournamentCustomEngine;
  const { TournamentClock } = window.TournamentTiming;
  const $ = id => document.getElementById(id);

  const ui = {
    board: $('chessboard'), title: $('game-title'), turn: $('turn-indicator'), hint: $('board-hint'), sessionStatus: $('session-status'),
    newGame: $('new-game'), undo: $('undo-move'), flip: $('flip-board'), engineSelect: $('engine-select'), engineSectionTitle: $('engine-section-title'), engineSelectLabel: $('engine-select-label'), depth: $('engine-depth'), depthValue: $('depth-value'), opponentDescription: $('opponent-description'), selectedEngineName: $('selected-engine-name'), selectedEngineStats: $('selected-engine-stats'),
    camera: $('camera-tilt'), resetCamera: $('reset-camera'), save: $('save-game'), moveList: $('move-list'), copyPgn: $('copy-pgn'), copyFen: $('copy-fen'), fen: $('fen-value'),
    connect: $('connect-engine'), engineDot: $('engine-dot'), engineLabel: $('engine-label'), engineMessage: $('engine-message'), evalScore: $('eval-score'), evalMeter: $('eval-meter-fill'), pv: $('pv-line'),
    promotion: $('promotion-dialog'), promotionOptions: $('promotion-options'), toast: $('toast'),
    menu: $('mode-menu'), openMenu: $('open-mode-menu'), launchAnalysis: $('launch-analysis'), launchTournamentSetup: $('launch-tournament-setup'), modeChoiceGrid: $('mode-choice-grid'), tournamentSetup: $('tournament-setup'), backToModeChoice: $('back-to-mode-choice'), tournamentOpponent: $('tournament-opponent'), tournamentColor: $('tournament-color'), tournamentTimeControl: $('tournament-time-control'), openTournamentRules: $('open-tournament-rules'), rules: $('tournament-rules'), rulesStart: $('rules-start'), rulesCancel: $('rules-cancel'),
    tournamentClocks: $('tournament-clocks'), whiteClock: $('white-clock'), blackClock: $('black-clock'), whiteClockTime: $('white-clock-time'), blackClockTime: $('black-clock-time'), timeControlLabel: $('time-control-label')
  };

  class TournamentRoom {
    constructor() {
      this.game = new ChessGame();
      this.storage = new GameStorage();
      this.engine = new StockfishClient();
      this.customEngine = new CustomChessEngine();
      this.appMode = 'analysis';
      this.tournament = null;
      this.clock = null;
      this.timeoutResult = null;
      this.pendingTournamentConfig = null;
      this.touchMove = null;
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
      this.renderer.setTournamentController({
        isActive: () => this.isTournament(),
        beginDrag: square => this.beginTournamentDrag(square),
        drop: destination => this.dropTournamentDrag(destination)
      });
      this.bindEvents();
      this.bindEngine();
      this.restoreLocalSession();
      this.setEngineControls();
      this.applyCamera();
      this.render();
      if (this.engineKind() === 'stockfish') this.connectEngine(true);
    }

    bindEvents() {
      ui.newGame.addEventListener('click', () => this.newGame());
      ui.undo.addEventListener('click', () => this.undo());
      ui.flip.addEventListener('click', () => { this.orientation = this.orientation === 'w' ? 'b' : 'w'; this.renderer.setOrientation(this.orientation); });
      ui.engineSelect.addEventListener('change', () => {
        if (this.isTournament()) return;
        this.cancelEngineSearch();
        this.lastEngineStats = '';
        this.setEngineControls();
        this.analyse();
      });
      ui.depth.addEventListener('input', () => this.updateDepth());
      ui.camera.addEventListener('input', () => { this.cameraState.pitch = Number(ui.camera.value); this.applyCamera(); });
      ui.resetCamera.addEventListener('click', () => this.resetCamera());
      ui.save.addEventListener('click', () => this.save());
      ui.copyPgn.addEventListener('click', () => this.copy(this.game.pgn(), 'PGN copied.'));
      ui.copyFen.addEventListener('click', () => this.copy(this.game.fen(), 'FEN copied.'));
      ui.connect.addEventListener('click', () => this.connectEngine());
      ui.openMenu.addEventListener('click', event => { event.preventDefault(); this.openModeMenu(); });
      ui.launchAnalysis.addEventListener('click', () => this.startAnalysis());
      ui.launchTournamentSetup.addEventListener('click', () => this.showTournamentSetup());
      ui.backToModeChoice.addEventListener('click', () => this.hideTournamentSetup());
      ui.openTournamentRules.addEventListener('click', () => this.openTournamentRules());
      ui.rulesStart.addEventListener('click', () => this.startTournament(this.pendingTournamentConfig));
      ui.rulesCancel.addEventListener('click', () => { ui.rules.close(); this.pendingTournamentConfig = null; });
      ui.whiteClock.addEventListener('click', () => this.pressPlayerClock('w'));
      ui.blackClock.addEventListener('click', () => this.pressPlayerClock('b'));
      window.addEventListener('keydown', event => this.handleCameraKey(event, true));
      window.addEventListener('keyup', event => this.handleCameraKey(event, false));
      window.addEventListener('blur', () => { this.cameraState.pressed.clear(); });
    }

    bindEngine() {
      this.engine.onStatus((status, detail) => {
        if (this.engineKind() !== 'stockfish') return;
        ui.engineDot.className = `engine-dot ${status === 'online' ? 'online' : status === 'connecting' ? 'connecting' : 'offline'}`;
        ui.engineDot.title = status === 'online' ? 'Stockfish connected' : status === 'connecting' ? 'Connecting to Stockfish' : 'Stockfish offline';
        if (status === 'connecting') { ui.engineMessage.textContent = 'Looking for the local Stockfish bridge…'; ui.connect.disabled = true; ui.connect.textContent = 'Connecting…'; }
        if (status === 'online') { ui.connect.disabled = false; ui.connect.textContent = 'Engine connected'; if (!this.isTournament()) ui.engineMessage.textContent = detail || 'Connected locally. Evaluation updates after each move.'; }
        if (status === 'offline') { ui.connect.disabled = false; ui.connect.textContent = 'Connect engine'; this.engineThinking = false; if (!this.isTournament()) ui.engineMessage.textContent = detail || 'Engine offline. Start the local bridge to analyse this board.'; }
      });
      this.engine.onAnalysis = message => {
        if (this.engineKind() !== 'stockfish' || message.fen !== this.game.fen()) return;
        const whiteScore = this.game.turn === 'w' ? Number(message.score) : -Number(message.score);
        const display = message.scoreType === 'mate' ? `M${whiteScore > 0 ? '+' : ''}${whiteScore}` : `${whiteScore >= 0 ? '+' : ''}${(whiteScore / 100).toFixed(2)}`;
        this.lastEngineStats = `${Number(message.nodes || 0).toLocaleString()} nodes · depth ${message.depth || ui.depth.value}`;
        this.refreshEngineProfile();
        ui.evalScore.textContent = display;
        ui.evalMeter.style.width = `${Math.max(4, Math.min(96, 50 + whiteScore / 24))}%`;
        ui.pv.textContent = message.pv || 'No principal variation returned.';
      };
      this.engine.onBestMove = message => {
        if (this.engineKind() !== 'stockfish' || !this.engineThinking || message.fen !== this.game.fen() || !this.isTournament()) return;
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
        if (['stockfish', 'custom'].includes(session.settings?.engine)) ui.engineSelect.value = session.settings.engine;
        if (session.settings?.depth) {
          const key = ui.engineSelect.value === 'custom' ? 'custom' : 'stockfish';
          this.depthSettings[key] = Number(session.settings.depth);
        }
      } catch { localStorage.removeItem('tournament-room.session.v1'); }
    }

    isTournament() { return this.appMode === 'tournament' && Boolean(this.tournament); }
    isGameOver() { return Boolean(this.game.result || this.timeoutResult); }
    resultText() { return this.timeoutResult || this.game.result; }
    engineKind() { return this.isTournament() ? this.tournament.opponent : ui.engineSelect.value; }
    engineColor() { return this.isTournament() ? this.tournament.engineColor : null; }
    playerColor() { return this.isTournament() ? this.tournament.playerColor : null; }
    engineName() { return this.engineKind() === 'custom' ? 'CustomChessEngine' : 'Stockfish'; }
    opponentName() { return this.engineName(); }

    getTimeControl(value = ui.tournamentTimeControl.value) {
      const [minutes, increment] = value.split('|').map(Number);
      return { value, minutes, increment, baseMs: minutes * 60_000, incrementMs: increment * 1_000, label: `${minutes} + ${increment}` };
    }

    showTournamentSetup() {
      ui.modeChoiceGrid.hidden = true;
      ui.tournamentSetup.hidden = false;
    }
    hideTournamentSetup() {
      ui.tournamentSetup.hidden = true;
      ui.modeChoiceGrid.hidden = false;
    }
    openModeMenu() {
      if (this.isTournament()) {
        this.clock?.stop();
        this.cancelEngineSearch();
        ui.hint.textContent = 'Tournament paused. Choose a new session to begin again.';
      }
      this.hideTournamentSetup();
      ui.menu.hidden = false;
    }
    startAnalysis() {
      this.leaveTournament();
      this.appMode = 'analysis';
      ui.menu.hidden = true;
      ui.engineSelect.disabled = false;
      this.timeoutResult = null;
      this.touchMove = null;
      this.clearSelection(false);
      this.setEngineControls();
      this.render();
      ui.hint.textContent = 'Select a piece to see its legal moves.';
      this.analyse();
    }
    openTournamentRules() {
      this.pendingTournamentConfig = {
        opponent: ui.tournamentOpponent.value,
        playerColor: ui.tournamentColor.value,
        ...this.getTimeControl()
      };
      ui.rules.showModal();
    }
    startTournament(config) {
      if (!config) return;
      ui.rules.close();
      this.leaveTournament();
      this.appMode = 'tournament';
      this.timeoutResult = null;
      this.tournament = {
        ...config,
        engineColor: config.playerColor === 'w' ? 'b' : 'w',
        awaitingClockPress: false,
        waitingForEngine: false
      };
      ui.engineSelect.value = config.opponent;
      ui.engineSelect.disabled = true;
      this.game.reset();
      this.orientation = config.playerColor;
      this.renderer.setOrientation(this.orientation);
      this.clearSelection(false);
      this.clock = new TournamentClock({
        baseMs: config.baseMs,
        incrementMs: config.incrementMs,
        onTick: () => this.renderClocks(),
        onFlag: color => this.handleTimeout(color)
      });
      ui.menu.hidden = true;
      this.setEngineControls();
      this.render();
      if (config.opponent === 'stockfish' && this.engine.status !== 'online') {
        this.tournament.waitingForEngine = true;
        ui.hint.textContent = 'Connecting Stockfish before the tournament clock starts…';
        this.engine.connect().then(() => {
          if (this.isTournament() && this.tournament.waitingForEngine) this.beginTournamentClock();
        }).catch(() => {
          if (!this.isTournament()) return;
          this.tournament.waitingForEngine = false;
          ui.hint.textContent = 'Stockfish could not connect. Start the local bridge, then use Connect engine.';
          this.showToast('Tournament clock has not started.');
          this.renderClocks();
        });
      } else {
        this.beginTournamentClock();
      }
    }
    leaveTournament() {
      this.clock?.dispose();
      this.clock = null;
      this.tournament = null;
      this.touchMove = null;
      this.timeoutResult = null;
      this.cancelEngineSearch();
      this.renderer.cancelTournamentDrag();
    }
    beginTournamentClock() {
      if (!this.isTournament() || this.isGameOver()) return;
      this.tournament.waitingForEngine = false;
      this.clock.start(this.game.turn);
      this.renderClocks();
      if (this.game.turn === this.playerColor()) ui.hint.textContent = 'Your clock is running. Touch a piece to begin your move.';
      this.maybeEngineTurn();
    }

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
      const custom = this.engineKind() === 'custom';
      const key = custom ? 'custom' : 'stockfish';
      const minDepth = custom ? 1 : 2;
      const maxDepth = custom ? 4 : 20;
      const depth = Math.max(minDepth, Math.min(maxDepth, this.depthSettings[key]));
      ui.depth.min = String(minDepth);
      ui.depth.max = String(maxDepth);
      ui.depth.value = String(depth);
      ui.depthValue.textContent = String(depth);
      ui.engineSectionTitle.textContent = this.isTournament() ? 'Tournament opponent' : 'Analysis';
      ui.engineSelectLabel.textContent = this.isTournament() ? 'Opponent engine' : 'Analysis engine';
      ui.opponentDescription.textContent = this.isTournament()
        ? `${this.engineName()} plays ${this.engineColor() === 'w' ? 'White' : 'Black'} in this timed match.`
        : custom ? 'Use CustomChessEngine for local classical analysis.' : 'Use Stockfish for local position analysis.';
      this.refreshEngineProfile();
      ui.engineLabel.textContent = this.engineName();
      if (custom) {
        ui.engineDot.className = 'engine-dot online';
        ui.engineDot.title = 'CustomChessEngine ready';
        ui.engineMessage.textContent = this.isTournament()
          ? 'Tournament opponent ready · aggressive classical play · approximately 1900 strength.'
          : 'Classical evaluation · aggressive style · approximately 1900 strength.';
        ui.pv.textContent = 'The custom engine searches locally in the browser.';
        ui.connect.disabled = true;
        ui.connect.textContent = 'CustomChessEngine ready';
      } else {
        ui.engineDot.className = `engine-dot ${this.engine.status === 'online' ? 'online' : this.engine.status === 'connecting' ? 'connecting' : 'offline'}`;
        ui.engineDot.title = this.engine.status === 'online' ? 'Stockfish connected' : this.engine.status === 'connecting' ? 'Connecting to Stockfish' : 'Stockfish offline';
        ui.connect.disabled = this.engine.status === 'connecting';
        ui.connect.textContent = this.engine.status === 'online' ? 'Engine connected' : this.engine.status === 'connecting' ? 'Connecting…' : 'Connect engine';
        ui.engineMessage.textContent = this.engine.status === 'online'
          ? (this.isTournament() ? 'Stockfish is ready for the tournament table.' : 'Connected locally. Evaluation updates after each move.')
          : 'Engine offline. Start the local bridge to analyse this board.';
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
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || ui.promotion.open || ui.rules.open) return;
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
    applyCamera() { ui.camera.value = String(this.cameraState.pitch); this.renderer.setCamera(this.cameraState); }
    resetCamera() { Object.assign(this.cameraState, { pitch: 54, yaw: 0, panX: 0, panY: 0, zoom: 1 }); this.applyCamera(); }

    isPlayerTurnReady() {
      return this.isTournament() && !this.isGameOver() && !this.engineThinking && !this.tournament.awaitingClockPress && !this.tournament.waitingForEngine && this.game.turn === this.playerColor() && this.clock?.activeColor === this.playerColor();
    }
    beginTournamentDrag(square) {
      if (!this.isPlayerTurnReady()) {
        if (this.tournament?.awaitingClockPress) this.showToast('Press your clock before the opponent can move.');
        else if (!this.engineThinking && !this.isGameOver()) this.showToast('Wait until your clock is running.');
        return null;
      }
      if (this.touchMove) return this.touchMove;
      const piece = square && this.game.getPiece(square.r, square.c);
      if (!piece || piece.color !== this.playerColor()) {
        this.showToast('Touch-move: select one of your own pieces.');
        return null;
      }
      const moves = this.game.legalMoves(square.r, square.c);
      if (!moves.length) { this.showToast('That piece has no legal moves.'); return null; }
      this.touchMove = { from: { ...square }, piece: { ...piece } };
      this.selected = { ...square };
      this.selectionMoves = moves;
      this.renderer.setSelection(this.selected, moves);
      ui.hint.textContent = `Touch-move: ${squareName(square.r, square.c)} must move. Release it on a legal square.`;
      return this.touchMove;
    }
    dropTournamentDrag(destination) {
      if (!this.touchMove) return;
      const target = destination && this.selectionMoves.find(move => move.to.r === destination.r && move.to.c === destination.c);
      if (target) {
        if (target.promotion) this.openPromotion(target);
        else this.commitMove(target);
        return;
      }
      this.renderer.setSelection(this.selected, this.selectionMoves);
      ui.hint.textContent = `Touch-move: ${squareName(this.touchMove.from.r, this.touchMove.from.c)} must move to a legal target.`;
    }
    handleSquare(square) {
      if (this.isTournament() || this.engineThinking || this.pendingPromotion || this.isGameOver()) return;
      const target = this.selectionMoves.find(move => move.to.r === square.r && move.to.c === square.c);
      if (this.selected && target) {
        if (target.promotion) this.openPromotion(target); else this.commitMove(target);
        return;
      }
      const piece = this.game.getPiece(square.r, square.c);
      if (piece?.color === this.game.turn) {
        this.selected = square;
        this.selectionMoves = this.game.legalMoves(square.r, square.c);
        this.renderer.setSelection(this.selected, this.selectionMoves);
        ui.hint.textContent = this.selectionMoves.length ? `${this.selectionMoves.length} legal move${this.selectionMoves.length === 1 ? '' : 's'} for ${squareName(square.r, square.c)}.` : 'This piece has no legal moves.';
      } else this.clearSelection();
    }
    openPromotion(move) {
      this.pendingPromotion = move;
      ui.promotionOptions.replaceChildren();
      const color = move.piece.color;
      const pieces = { q: color === 'w' ? '♕' : '♛', r: color === 'w' ? '♖' : '♜', b: color === 'w' ? '♗' : '♝', n: color === 'w' ? '♘' : '♞' };
      Object.entries(pieces).forEach(([type, symbol]) => {
        const button = document.createElement('button');
        button.className = 'promotion-choice'; button.type = 'button'; button.textContent = symbol;
        button.setAttribute('aria-label', `Promote to ${({ q: 'queen', r: 'rook', b: 'bishop', n: 'knight' })[type]}`);
        button.addEventListener('click', () => { ui.promotion.close(); const promotion = { ...this.pendingPromotion, promotionChoice: type }; this.pendingPromotion = null; this.commitMove(promotion); });
        ui.promotionOptions.append(button);
      });
      ui.promotion.showModal();
    }

    commitMove(move, fromEngine = false) {
      const { san } = this.game.apply(move);
      this.clearSelection(false);
      if (this.game.result) {
        this.clock?.stop();
        this.render();
        ui.hint.textContent = this.game.result;
        this.showToast(this.game.result);
        return;
      }
      this.render();
      if (this.isTournament()) {
        if (fromEngine) this.completeEngineTurn(san);
        else this.awaitPlayerClockPress(san);
      } else {
        ui.hint.textContent = `${san} recorded. ${this.game.turn === 'w' ? 'White' : 'Black'} to move.`;
      }
      this.analyse();
    }
    awaitPlayerClockPress(san) {
      this.tournament.awaitingClockPress = true;
      this.renderClocks();
      ui.hint.textContent = `${san} played. Press your clock to start ${this.opponentName()}.`;
    }
    pressPlayerClock(color) {
      if (!this.isTournament() || color !== this.playerColor() || !this.tournament.awaitingClockPress) return;
      if (!this.clock.press(color)) return;
      this.tournament.awaitingClockPress = false;
      this.clock.start(this.engineColor());
      this.renderClocks();
      ui.hint.textContent = `${this.opponentName()} is considering the position…`;
      this.maybeEngineTurn();
    }
    completeEngineTurn(san) {
      if (this.isGameOver()) return;
      if (!this.clock.press(this.engineColor())) return;
      this.clock.start(this.playerColor());
      this.renderClocks();
      ui.hint.textContent = `${this.opponentName()} played ${san} and pressed the clock. Your move.`;
    }
    handleTimeout(color) {
      if (!this.isTournament() || this.timeoutResult) return;
      const winner = color === 'w' ? 'Black' : 'White';
      this.timeoutResult = `${winner} wins by timeout`;
      this.cancelEngineSearch();
      this.clearSelection(false);
      this.render();
      ui.hint.textContent = this.timeoutResult;
      this.showToast(this.timeoutResult);
    }

    maybeEngineTurn() {
      if (!this.isTournament() || this.isGameOver() || this.tournament.awaitingClockPress || this.tournament.waitingForEngine) return;
      const engineColor = this.engineColor();
      if (engineColor !== this.game.turn || this.clock?.activeColor !== engineColor || this.engineThinking) return;
      const kind = this.engineKind();
      if (kind === 'stockfish' && this.engine.status !== 'online') return;
      this.engineThinking = true;
      const token = ++this.engineRequestToken;
      const fen = this.game.fen();
      ui.hint.textContent = `${this.opponentName()} is considering the position…`;
      if (kind === 'custom') {
        this.customEngine.chooseMove(this.game, Number(ui.depth.value)).then(result => {
          if (!result || token !== this.engineRequestToken || !this.engineThinking || this.game.fen() !== fen || !this.isTournament()) return;
          this.engineThinking = false;
          const move = this.game.moveFromUci(result.move);
          if (!move) { this.showToast('Custom engine could not resolve a legal move.'); return; }
          this.lastEngineStats = `${Number(result.nodes).toLocaleString()} nodes · ${Math.round(result.elapsedMs)} ms`;
          this.refreshEngineProfile();
          ui.evalScore.textContent = `${result.score >= 0 ? '+' : ''}${(result.score / 100).toFixed(2)}`;
          ui.evalMeter.style.width = `${Math.max(4, Math.min(96, 50 + result.score / 24))}%`;
          ui.pv.textContent = `${result.style} · depth ${result.depth} · ${Number(result.nodes).toLocaleString()} nodes`;
          this.commitMove(move, true);
        }).catch(error => {
          if (token !== this.engineRequestToken) return;
          this.engineThinking = false;
          this.showToast(error?.message || 'CustomChessEngine could not complete this search.');
        });
      } else this.engine.requestMove(fen, Number(ui.depth.value));
    }
    cancelEngineSearch() {
      this.customEngine.cancel();
      this.engineRequestToken += 1;
      this.engineThinking = false;
    }

    newGame() {
      if (this.isTournament()) {
        const config = { ...this.tournament };
        this.startTournament(config);
        this.showToast('Tournament restarted with the same match settings.');
        return;
      }
      this.cancelEngineSearch();
      this.game.reset(); this.timeoutResult = null; this.clearSelection(false);
      this.render();
      ui.hint.textContent = 'New analysis board ready. White to move.';
      this.analyse();
    }
    undo() {
      if (this.isTournament()) { this.showToast('Take-backs are disabled in tournament simulation.'); return; }
      if (!this.game.undo()) { this.showToast('There is no move to take back.'); return; }
      this.clearSelection(false); this.render(); this.analyse(); this.showToast('Move taken back.');
    }
    clearSelection(render = true) {
      this.selected = null;
      this.selectionMoves = [];
      this.touchMove = null;
      this.renderer.selected = null;
      this.renderer.legalMoves = [];
      this.renderer.cancelTournamentDrag();
      if (render) this.renderer.render();
    }
    analyse() { if (this.engineKind() === 'stockfish' && this.engine.status === 'online') this.engine.analyse(this.game.fen(), Number(ui.depth.value)); }
    connectEngine(silent = false) {
      if (this.engineKind() === 'custom') { this.showToast('The custom engine runs locally in this browser.'); return; }
      this.engine.connect().then(() => {
        this.analyse();
        if (this.isTournament() && this.tournament.waitingForEngine) this.beginTournamentClock();
      }).catch(() => { if (!silent) this.showToast('Bridge unavailable. See the setup guide.'); });
    }

    formatClock(milliseconds) {
      const safe = Math.max(0, milliseconds);
      const minutes = Math.floor(safe / 60_000);
      const seconds = Math.floor(safe / 1_000) % 60;
      if (safe < 60_000) return `0:${String(seconds).padStart(2, '0')}.${Math.floor(safe / 100) % 10}`;
      return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }
    renderClocks() {
      const active = this.isTournament();
      ui.tournamentClocks.hidden = !active;
      if (!active) return;
      const snapshot = this.clock?.snapshot() || { white: this.tournament.baseMs, black: this.tournament.baseMs, activeColor: null };
      ui.whiteClockTime.textContent = this.formatClock(snapshot.white);
      ui.blackClockTime.textContent = this.formatClock(snapshot.black);
      ui.timeControlLabel.textContent = this.tournament.label;
      [['w', ui.whiteClock], ['b', ui.blackClock]].forEach(([color, button]) => {
        const player = color === this.playerColor();
        const awaiting = player && this.tournament.awaitingClockPress;
        button.disabled = !awaiting;
        button.className = `chess-clock ${color === 'w' ? 'white-clock' : 'black-clock'}${snapshot.activeColor === color ? ' active' : ''}${awaiting ? ' awaiting' : ''}`;
        button.setAttribute('aria-label', `${color === 'w' ? 'White' : 'Black'} clock: ${this.formatClock(color === 'w' ? snapshot.white : snapshot.black)}${awaiting ? '. Press to end your turn.' : ''}`);
      });
    }
    render() {
      this.renderer.setGame(this.game);
      this.renderHeader();
      this.renderMoves();
      this.renderClocks();
      ui.fen.textContent = this.game.fen();
    }
    renderHeader() {
      const result = this.resultText();
      const title = this.isTournament() ? `Tournament · vs ${this.engineName()}` : 'Analysis board';
      ui.title.textContent = result || title;
      const turnColor = this.game.turn === 'w' ? 'white-piece' : 'black-piece';
      const turnIcon = this.game.turn === 'w' ? '♔' : '♚';
      ui.turn.innerHTML = `<span class="turn-piece ${turnColor}">${turnIcon}</span><span>${result || `${this.game.turn === 'w' ? 'White' : 'Black'} to move`}</span>`;
      ui.sessionStatus.innerHTML = this.isTournament()
        ? `<span class="pulse"></span> Tournament simulation · ${this.tournament.label}`
        : '<span class="pulse"></span> Practice table · Local session';
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
      this.storage.saveSession(this.game, { mode: this.appMode, engine: this.engineKind(), depth: ui.depth.value, tournament: this.isTournament() ? { opponent: this.tournament.opponent, playerColor: this.playerColor(), timeControl: this.tournament.value } : null });
      this.storage.downloadPgn(this.game);
      this.showToast('Saved locally and exported as a PGN file.');
    }
    async copy(value, message) {
      try { await navigator.clipboard.writeText(value); }
      catch { const field = document.createElement('textarea'); field.value = value; document.body.append(field); field.select(); document.execCommand('copy'); field.remove(); }
      this.showToast(message);
    }
    showToast(message) { clearTimeout(this.toastTimer); ui.toast.textContent = message; ui.toast.classList.add('show'); this.toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 3200); }
  }

  window.addEventListener('DOMContentLoaded', () => { window.tournamentRoom = new TournamentRoom(); });
})();
