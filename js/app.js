(function () {
  'use strict';

  const { ChessGame, squareName, moveToUci } = window.ChessDomain;
  const { BoardRenderer } = window.TournamentRenderer;
  const { GameStorage } = window.TournamentStorage;
  const { StockfishClient } = window.TournamentEngine;
  const { CustomChessEngine } = window.TournamentCustomEngine;
  const { TournamentClock } = window.TournamentTiming;
  const { RoomClient, createRoomCode, normalizeRoom } = window.TournamentMultiplayer;
  const { CoachController } = window.TournamentCoach;
  const { GroundingCoachClient } = window.TournamentGrounding;
  const { OpeningPrepController } = window.TournamentOpeningPrep;
  const $ = id => document.getElementById(id);

  const ui = {
    board: $('chessboard'), title: $('game-title'), turn: $('turn-indicator'), hint: $('board-hint'), sessionStatus: $('session-status'),
    leftRail: document.querySelector('.left-rail'), rightRail: document.querySelector('.right-rail'), mobileControls: $('mobile-controls-toggle'), mobileInsights: $('mobile-insights-toggle'),
    newGame: $('new-game'), undo: $('undo-move'), flip: $('flip-board'), engineSelect: $('engine-select'), engineSectionTitle: $('engine-section-title'), engineSelectLabel: $('engine-select-label'), depth: $('engine-depth'), depthValue: $('depth-value'), opponentDescription: $('opponent-description'), selectedEngineName: $('selected-engine-name'), selectedEngineStats: $('selected-engine-stats'), engineModeSection: $('engine-mode-section'),
    camera: $('camera-tilt'), resetCamera: $('reset-camera'), save: $('save-game'), moveList: $('move-list'), copyPgn: $('copy-pgn'), copyFen: $('copy-fen'), fen: $('fen-value'),
    connect: $('connect-engine'), engineDot: $('engine-dot'), engineLabel: $('engine-label'), engineMessage: $('engine-message'), evalScore: $('eval-score'), evalMeter: $('eval-meter-fill'), pv: $('pv-line'), analysisCard: $('analysis-card'), analysisCardTitle: $('analysis-card-title'), depthControl: $('engine-depth-control'),
    promotion: $('promotion-dialog'), promotionOptions: $('promotion-options'), toast: $('toast'),
    menu: $('mode-menu'), openMenu: $('open-mode-menu'), launchAnalysis: $('launch-analysis'), launchCoach: $('launch-coach'), launchOpeningPrep: $('launch-opening-prep'), launchTournamentSetup: $('launch-tournament-setup'), modeChoiceGrid: $('mode-choice-grid'), tournamentSetup: $('tournament-setup'), backToModeChoice: $('back-to-mode-choice'), tournamentOpponent: $('tournament-opponent'), tournamentColor: $('tournament-color'), tournamentColorLabel: $('tournament-color-label'), tournamentTimeControl: $('tournament-time-control'), peerRoleField: $('peer-role-field'), peerRole: $('peer-role'), openTournamentRules: $('open-tournament-rules'), rules: $('tournament-rules'), rulesEyebrow: $('rules-eyebrow'), rulesTitle: $('rules-title'), rulesClockCopy: $('rules-clock-copy'), rulesStart: $('rules-start'), rulesCancel: $('rules-cancel'),
    peerDialog: $('peer-dialog'), peerDialogTitle: $('peer-dialog-title'), peerStatus: $('peer-status'), peerHostFlow: $('peer-host-flow'), peerGuestFlow: $('peer-guest-flow'), peerRoomOutput: $('peer-room-output'), copyPeerRoom: $('copy-peer-room'), peerRoomInput: $('peer-room-input'), joinPeerRoom: $('join-peer-room'), peerError: $('peer-error'), cancelPeerPairing: $('cancel-peer-pairing'),
    tournamentClocks: $('tournament-clocks'), whiteClock: $('white-clock'), blackClock: $('black-clock'), whiteClockTime: $('white-clock-time'), blackClockTime: $('black-clock-time'), timeControlLabel: $('time-control-label'),
    coachCard: $('coach-card'), coachDot: $('coach-dot'), coachMoveTab: $('coach-move-tab'), coachPositionTab: $('coach-position-tab'), coachModelState: $('coach-model-state'), coachModelDot: $('coach-model-dot'), coachModelStatus: $('coach-model-status'), coachModelRetry: $('coach-model-retry'), coachStatus: $('coach-status'), coachBody: $('coach-body'), coachConnect: $('coach-connect'), coachExportData: $('coach-export-data'),
    variationControls: $('variation-controls'), variationPrevious: $('variation-previous'), variationNext: $('variation-next'), variationExit: $('variation-exit'), variationLabel: $('variation-label'),
    openingControls: $('opening-controls'), openingCard: $('opening-card'), openingSelect: $('opening-select'), openingChapter: $('opening-chapter'), openingSide: $('opening-side'), openingWorkflow: $('opening-workflow'), openingRestart: $('opening-restart'), openingCardTitle: $('opening-card-title'), openingChapterTitle: $('opening-chapter-title'), openingProgress: $('opening-progress'), openingDescription: $('opening-description'), openingIdeas: $('opening-ideas'), openingLine: $('opening-line'), openingFeedback: $('opening-feedback'), openingPrevious: $('opening-previous'), openingNext: $('opening-next')
  };

  class TournamentRoom {
    constructor() {
      this.game = new ChessGame();
      this.storage = new GameStorage();
      const ports = document.documentElement.dataset;
      this.engine = new StockfishClient(`ws://127.0.0.1:${ports.bridgePort}/`);
      this.customEngine = new CustomChessEngine();
      this.groundingCoach = new GroundingCoachClient({ url: `http://127.0.0.1:${ports.groundingPort}` });
      this.roomClient = new RoomClient({
        port: ports.roomPort,
        onStatus: (status, detail) => this.handleRoomStatus(status, detail),
        onMessage: (type, payload) => this.handleRoomMessage(type, payload)
      });
      this.appMode = 'analysis';
      this.tournament = null;
      this.clock = null;
      this.timeoutResult = null;
      this.pendingTournamentConfig = null;
      this.peerMatchStarted = false;
      this.touchMove = null;
      this.selected = null;
      this.selectionMoves = [];
      this.orientation = 'w';
      this.pendingPromotion = null;
      this.engineThinking = false;
      this.engineRequestToken = 0;
      this.preview = null;
      this.depthSettings = { stockfish: 14, custom: 4 };
      this.lastEngineStats = '';
      this.cameraState = { pitch: 54, yaw: 0, panX: 0, panY: 0, zoom: 1, pressed: new Set(), frame: null };
      this.renderer = new BoardRenderer(ui.board, square => this.handleSquare(square));
      document.querySelector('.camera-section').hidden = !this.renderer.solidScene?.available;
      $('flat-board-note').hidden = Boolean(this.renderer.solidScene?.available);
      this.renderer.setTournamentController({
        isActive: () => this.isTournament(),
        beginDrag: square => this.beginTournamentDrag(square),
        drop: destination => this.dropTournamentDrag(destination)
      });
      this.coach = new CoachController({
        engine: this.engine,
        grounding: this.groundingCoach,
        getDepth: () => Number(ui.depth.value),
        ui: { card: ui.coachCard, dot: ui.coachDot, moveTab: ui.coachMoveTab, positionTab: ui.coachPositionTab, status: ui.coachStatus, body: ui.coachBody, exportData: ui.coachExportData },
        onPreview: (variation, label) => this.startVariationPreview(variation, label),
      });
      this.openingPrep = new OpeningPrepController({
        ui: { opening: ui.openingSelect, chapter: ui.openingChapter, side: ui.openingSide, workflow: ui.openingWorkflow, restart: ui.openingRestart, title: ui.openingCardTitle, chapterTitle: ui.openingChapterTitle, progress: ui.openingProgress, description: ui.openingDescription, ideas: ui.openingIdeas, line: ui.openingLine, feedback: ui.openingFeedback, previous: ui.openingPrevious, next: ui.openingNext },
        onChange: () => this.render(),
        onHint: message => { ui.hint.textContent = message; },
      });
      this.bindEvents();
      this.bindGrounding();
      this.bindEngine();
      this.restoreLocalSession();
      this.setEngineControls();
      this.applyCamera();
      this.render();
      ui.launchAnalysis.focus();
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
        if (this.engineKind() === 'stockfish') { this.resetEvaluation(); this.connectEngine(true); }
        else this.analyse();
      });
      ui.depth.addEventListener('input', () => this.updateDepth());
      ui.camera.addEventListener('input', () => { this.cameraState.pitch = Number(ui.camera.value); this.applyCamera(); });
      ui.resetCamera.addEventListener('click', () => this.resetCamera());
      ui.save.addEventListener('click', () => this.save());
      ui.copyPgn.addEventListener('click', () => this.copy(this.game.pgn(), 'PGN copied.'));
      ui.copyFen.addEventListener('click', () => this.copy(this.game.fen(), 'FEN copied.'));
      ui.connect.addEventListener('click', () => this.connectEngine());
      $('tournament-reconnect').addEventListener('click', () => this.connectEngine());
      ui.promotion.addEventListener('cancel', () => { this.pendingPromotion = null; });
      ui.coachConnect.addEventListener('click', () => this.connectEngine());
      ui.coachModelRetry.addEventListener('click', () => this.connectGrounding());
      ui.openMenu.addEventListener('click', event => { event.preventDefault(); this.openModeMenu(); });
      ui.launchAnalysis.addEventListener('click', () => this.startAnalysis());
      ui.launchCoach.addEventListener('click', () => this.startCoach());
      ui.launchOpeningPrep.addEventListener('click', () => this.startOpeningPrep());
      ui.launchTournamentSetup.addEventListener('click', () => this.showTournamentSetup());
      ui.backToModeChoice.addEventListener('click', () => this.hideTournamentSetup());
      ui.tournamentOpponent.addEventListener('change', () => this.updateTournamentSetup());
      ui.peerRole.addEventListener('change', () => this.updateTournamentSetup());
      ui.openTournamentRules.addEventListener('click', () => this.openTournamentRules());
      ui.rulesStart.addEventListener('click', () => {
        if (this.pendingTournamentConfig?.opponent === 'peer') this.startRoomPairing(this.pendingTournamentConfig);
        else this.startTournament(this.pendingTournamentConfig);
      });
      ui.rulesCancel.addEventListener('click', () => { ui.rules.close(); this.pendingTournamentConfig = null; });
      ui.copyPeerRoom.addEventListener('click', () => this.copy(ui.peerRoomOutput.value, 'Room code copied.'));
      ui.peerRoomInput.addEventListener('input', () => { ui.peerRoomInput.value = normalizeRoom(ui.peerRoomInput.value); });
      ui.joinPeerRoom.addEventListener('click', () => this.joinRoom());
      ui.cancelPeerPairing.addEventListener('click', () => this.cancelRoomPairing());
      ui.whiteClock.addEventListener('click', () => this.pressPlayerClock('w'));
      ui.blackClock.addEventListener('click', () => this.pressPlayerClock('b'));
      ui.variationPrevious.addEventListener('click', () => this.stepVariation(-1));
      ui.variationNext.addEventListener('click', () => this.stepVariation(1));
      ui.variationExit.addEventListener('click', () => this.exitVariationPreview());
      ui.mobileControls.addEventListener('click', () => { ui.leftRail.classList.toggle('mobile-open'); ui.rightRail.classList.remove('mobile-open'); });
      ui.mobileInsights.addEventListener('click', () => { ui.rightRail.classList.toggle('mobile-open'); ui.leftRail.classList.remove('mobile-open'); });
      window.addEventListener('keydown', event => this.handleCameraKey(event, true));
      window.addEventListener('keyup', event => this.handleCameraKey(event, false));
      window.addEventListener('blur', () => { this.cameraState.pressed.clear(); });
    }

    bindEngine() {
      this.engine.onStatus((status, detail) => {
        if (this.engineKind() !== 'stockfish') return;
        $('tournament-reconnect').hidden = !this.isTournament() || status !== 'offline' || this.isGameOver();
        ui.coachDot.className = `engine-dot ${status}`;
        ui.engineDot.className = `engine-dot ${status === 'online' ? 'online' : status === 'connecting' ? 'connecting' : 'offline'}`;
        ui.engineDot.title = status === 'online' ? 'Stockfish connected' : status === 'connecting' ? 'Connecting to Stockfish' : 'Stockfish offline';
        if (status === 'connecting') { ui.engineMessage.textContent = 'Looking for the local Stockfish bridge…'; ui.connect.disabled = true; ui.connect.textContent = 'Connecting…'; ui.coachConnect.disabled = true; ui.coachConnect.textContent = 'Connecting…'; }
        if (status === 'online') {
          ui.connect.disabled = false; ui.connect.textContent = 'Engine connected';
          ui.coachConnect.disabled = true; ui.coachConnect.textContent = 'Stockfish connected';
          if (!this.isTournament()) ui.engineMessage.textContent = detail || 'Connected locally. Evaluation updates after each move.';
          if (this.isCoach()) this.coach.start(this.game);
        }
        if (status === 'offline') {
          ui.connect.disabled = false; ui.connect.textContent = 'Connect engine'; this.engineThinking = false;
          ui.coachConnect.disabled = false; ui.coachConnect.textContent = 'Connect Stockfish';
          if (this.isTournament() && !this.isGameOver() && ui.menu.hidden) {
            this.tournament.waitingForEngine = true;
            this.clock?.stop();
            ui.hint.textContent = 'Clock paused. Start the local bridge and choose Reconnect Stockfish.';
          } else {
            ui.engineMessage.textContent = detail || 'Engine offline. Start the local bridge or select CustomChessEngine.';
          }
          this.resetEvaluation();
          if (this.isCoach()) this.coach.start(this.game);
        }
      });
      this.engine.onAnalysis = message => {
        if (this.appMode !== 'analysis' || !ui.menu.hidden || this.engineKind() !== 'stockfish' || message.requestId !== this.analysisRequestId || message.fen !== this.game.fen()) return;
        const whiteScore = this.game.turn === 'w' ? Number(message.score) : -Number(message.score);
        const display = message.scoreType === 'mate' ? `M${whiteScore > 0 ? '+' : ''}${whiteScore}` : `${whiteScore >= 0 ? '+' : ''}${(whiteScore / 100).toFixed(2)}`;
        this.lastEngineStats = `${Number(message.nodes || 0).toLocaleString()} nodes · depth ${message.depth || ui.depth.value}`;
        this.refreshEngineProfile();
        ui.evalScore.textContent = display;
        const meter = message.scoreType === 'mate' ? (whiteScore > 0 ? 96 : 4) : 50 + whiteScore / 24;
        ui.evalMeter.style.width = `${Math.max(4, Math.min(96, meter))}%`;
        ui.pv.textContent = message.pv || 'No principal variation returned.';
      };
      this.engine.onBestMove = message => {
        if (this.engineKind() !== 'stockfish' || !this.engineThinking || message.fen !== this.game.fen() || !this.isTournament()) return;
        this.engineThinking = false;
        const move = this.game.moveFromUci(message.move);
        if (!move) { this.showToast('Stockfish returned an invalid move for this position.'); return; }
        this.commitMove(move, 'engine');
      };
    }

    bindGrounding() {
      this.groundingCoach.onStatus((status, model) => {
        ui.coachModelState.dataset.state = status;
        ui.coachModelDot.title = status === 'online' ? 'Neural model connected' : status === 'connecting' ? 'Connecting neural model' : 'Neural model offline';
        if (status === 'connecting') {
          ui.coachModelStatus.textContent = 'Connecting the neural chess model...';
          return;
        }
        if (status === 'online') {
          const parameters = Number(model?.parameters || 0);
          const size = parameters ? `${(parameters / 1_000_000).toFixed(1)}M parameters` : 'trained checkpoint';
          const precision = String(model?.precision || 'fp32').toUpperCase();
          ui.coachModelStatus.textContent = `Neural model ready · ${size} · ${precision}`;
          return;
        }
        ui.coachModelStatus.textContent = 'Optional neural model offline';
      });
    }

    connectGrounding(silent = false) {
      return this.groundingCoach.connect().catch(error => {
        if (!silent && this.isCoach()) this.showToast(error.message || 'The neural model is unavailable.');
        return null;
      });
    }

    restoreLocalSession() {
      const session = this.storage.loadSession();
      if (!session) return;
      try {
        if (session.schemaVersion === 2 && session.startFen && Array.isArray(session.moves)) {
          const restored = new ChessGame(session.startFen);
          session.moves.forEach(entry => {
            const move = restored.moveFromUci(entry.uci);
            if (!move) throw new Error('Saved move is not legal.');
            restored.apply(move);
          });
          this.game = restored.fen() === session.fen ? restored : new ChessGame(session.fen);
        } else this.game = new ChessGame(session.fen);
        if (['stockfish', 'custom'].includes(session.settings?.engine)) ui.engineSelect.value = session.settings.engine;
        if (session.settings?.depth) {
          const key = ui.engineSelect.value === 'custom' ? 'custom' : 'stockfish';
          this.depthSettings[key] = Number(session.settings.depth);
        }
      } catch { localStorage.removeItem('tournament-room.session.v1'); }
    }

    isTournament() { return this.appMode === 'tournament' && Boolean(this.tournament); }
    isCoach() { return this.appMode === 'coach'; }
    isOpeningPrep() { return this.appMode === 'opening-prep'; }
    isGameOver() { return Boolean(this.game.result || this.timeoutResult); }
    resultText() { return this.timeoutResult || this.game.result; }
    engineKind() { return this.isTournament() ? this.tournament.opponent : ui.engineSelect.value; }
    opponentColor() { return this.isTournament() ? this.tournament.opponentColor : null; }
    engineColor() { return this.engineKind() === 'peer' ? null : this.opponentColor(); }
    playerColor() { return this.isTournament() ? this.tournament.playerColor : null; }
    isPeerTournament() { return this.isTournament() && this.engineKind() === 'peer'; }
    engineName() { return this.engineKind() === 'peer' ? 'Another device' : this.engineKind() === 'custom' ? 'CustomChessEngine' : 'Stockfish'; }
    opponentName() { return this.engineName(); }

    getTimeControl(value = ui.tournamentTimeControl.value) {
      const [minutes, increment] = value.split('|').map(Number);
      return { value, minutes, increment, baseMs: minutes * 60_000, incrementMs: increment * 1_000, label: `${minutes} + ${increment}` };
    }

    showTournamentSetup() {
      ui.modeChoiceGrid.hidden = true;
      ui.tournamentSetup.hidden = false;
      this.updateTournamentSetup();
      ui.tournamentOpponent.focus();
    }
    hideTournamentSetup() {
      ui.tournamentSetup.hidden = true;
      ui.modeChoiceGrid.hidden = false;
    }
    openModeMenu() {
      this.exitVariationPreview(false);
      this.cameraState.pressed.clear();
      this.cancelEngineSearch();
      this.coach.stop();
      this.openingPrep.stop();
      if (this.isTournament()) {
        if (this.isPeerTournament()) {
          this.leaveTournament();
          ui.hint.textContent = 'Network match ended. Choose a new session to begin again.';
        } else {
          this.clock?.stop();
          ui.hint.textContent = 'Tournament paused. Choose a new session to begin again.';
        }
      }
      this.hideTournamentSetup();
      this.setMenuVisible(true);
    }
    setMenuVisible(visible) {
      ui.menu.hidden = !visible;
      document.querySelector('.app-shell').inert = visible;
      if (visible) ui.launchAnalysis.focus();
      else this.renderer.focus();
    }
    startAnalysis() {
      const previousMode = this.appMode;
      this.leaveTournament();
      this.coach.stop();
      this.openingPrep.stop();
      this.appMode = 'analysis';
      if (previousMode === 'opening-prep') this.game = new ChessGame();
      this.setMenuVisible(false);
      if (ui.engineSelect.value === 'peer') ui.engineSelect.value = 'custom';
      ui.engineSelect.disabled = false;
      this.timeoutResult = null;
      this.touchMove = null;
      this.clearSelection(false);
      this.setEngineControls();
      this.render();
      ui.hint.textContent = 'Select a piece to see its legal moves.';
      if (this.engineKind() === 'stockfish') this.connectEngine(true);
      else this.analyse();
    }
    startCoach() {
      const previousMode = this.appMode;
      this.leaveTournament();
      this.openingPrep.stop();
      this.appMode = 'coach';
      if (previousMode === 'opening-prep' || previousMode === 'tournament') this.game = new ChessGame();
      this.setMenuVisible(false);
      ui.engineSelect.value = 'stockfish';
      ui.engineSelect.disabled = true;
      this.timeoutResult = null;
      this.touchMove = null;
      this.clearSelection(false);
      this.setEngineControls();
      this.render();
      ui.hint.textContent = 'Play a move. The coach will explain its consequences and strongest continuation.';
      this.connectGrounding(true);
      this.coach.start(this.game);
      if (this.engine.status !== 'online') this.connectEngine(true);
    }
    startOpeningPrep() {
      this.leaveTournament();
      this.coach.stop();
      this.appMode = 'opening-prep';
      this.game = new ChessGame();
      this.setMenuVisible(false);
      ui.engineSelect.disabled = false;
      this.timeoutResult = null;
      this.touchMove = null;
      this.clearSelection(false);
      this.setEngineControls();
      this.render();
      ui.hint.textContent = 'Choose a lesson, then step through it or practice the line from memory.';
      this.openingPrep.start(this.game);
    }
    openTournamentRules() {
      this.pendingTournamentConfig = {
        opponent: ui.tournamentOpponent.value,
        playerColor: ui.tournamentColor.value,
        role: ui.peerRole.value,
        ...this.getTimeControl()
      };
      const peer = this.pendingTournamentConfig.opponent === 'peer';
      ui.rulesEyebrow.textContent = peer ? 'Local network tournament' : 'Tournament simulation';
      ui.rulesTitle.textContent = peer ? 'Two-device tournament rules' : 'Over-the-board rules';
      ui.rulesClockCopy.textContent = peer
        ? 'Your clock keeps running after you move. Press it to complete the turn; the move and synchronized clock are relayed to the other device.'
        : 'Your clock keeps running after you move. Press your clock to complete the turn and start your opponent’s clock. The engine presses its clock automatically after moving.';
      ui.rulesStart.textContent = peer ? 'I understand · Pair devices' : 'I understand · Start game';
      ui.rules.showModal();
    }
    updateTournamentSetup() {
      const peer = ui.tournamentOpponent.value === 'peer';
      const joining = peer && ui.peerRole.value === 'guest';
      ui.peerRoleField.hidden = !peer;
      ui.tournamentColorLabel.textContent = peer ? (joining ? 'Chosen by host' : 'Host color') : 'Your color';
      ui.tournamentColor.disabled = joining;
      ui.tournamentTimeControl.disabled = joining;
      ui.openTournamentRules.textContent = peer ? 'Review rules · Pair devices' : 'Review rules · Start tournament';
    }
    startTournament(config, { keepRoom = false } = {}) {
      if (!config) return;
      if (ui.rules.open) ui.rules.close();
      if (ui.peerDialog.open) ui.peerDialog.close();
      this.leaveTournament({ keepRoom });
      this.appMode = 'tournament';
      this.timeoutResult = null;
      this.tournament = {
        ...config,
        opponentColor: config.playerColor === 'w' ? 'b' : 'w',
        awaitingClockPress: false,
        waitingForEngine: false,
        waitingForRemoteClock: false
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
      this.setMenuVisible(false);
      this.setEngineControls();
      this.render();
      if (config.opponent === 'stockfish' && this.engine.status !== 'online') {
        this.tournament.waitingForEngine = true;
        ui.hint.textContent = 'Connecting Stockfish before the tournament clock starts…';
        this.connectEngine(true);
      } else {
        this.beginTournamentClock();
      }
    }
    leaveTournament({ keepRoom = false } = {}) {
      this.clock?.dispose();
      this.clock = null;
      this.tournament = null;
      this.touchMove = null;
      this.lastEngineStats = '';
      this.timeoutResult = null;
      this.cancelEngineSearch();
      this.renderer.cancelTournamentDrag();
      if (!keepRoom) {
        this.roomClient.close(false);
        this.peerMatchStarted = false;
      }
    }
    beginTournamentClock() {
      if (!this.isTournament() || this.isGameOver()) return;
      this.tournament.waitingForEngine = false;
      this.clock.start(this.tournament.awaitingClockPress ? this.playerColor() : this.game.turn);
      this.renderClocks();
      if (this.tournament.awaitingClockPress) ui.hint.textContent = 'Press your clock to complete your turn.';
      else if (this.game.turn === this.playerColor()) ui.hint.textContent = 'Your clock is running. Touch a piece to begin your move.';
      else if (this.isPeerTournament()) ui.hint.textContent = 'Waiting for the other player’s move…';
      else this.maybeEngineTurn();
    }

    startRoomPairing(config) {
      if (ui.rules.open) ui.rules.close();
      this.leaveTournament();
      this.pendingTournamentConfig = { ...config, opponent: 'peer' };
      this.peerMatchStarted = false;
      ui.peerError.hidden = true;
      ui.peerError.textContent = '';
      ui.peerHostFlow.hidden = config.role !== 'host';
      ui.peerGuestFlow.hidden = config.role !== 'guest';
      ui.peerDialogTitle.textContent = config.role === 'host' ? 'Create a tournament room' : 'Join a tournament room';
      ui.peerStatus.dataset.state = 'connecting';
      ui.peerStatus.textContent = config.role === 'host' ? 'Creating room' : 'Enter room code';
      ui.peerRoomInput.value = '';
      ui.peerDialog.showModal();

      if (config.role === 'host') {
        const room = createRoomCode();
        ui.peerRoomOutput.value = room;
        this.roomClient.connect(room, 'host').catch(error => this.showRoomError(error.message));
      }
    }

    joinRoom() {
      const room = normalizeRoom(ui.peerRoomInput.value);
      ui.peerRoomInput.value = room;
      ui.joinPeerRoom.disabled = true;
      ui.peerError.hidden = true;
      this.roomClient.connect(room, 'guest')
        .catch(error => this.showRoomError(error.message))
        .finally(() => { ui.joinPeerRoom.disabled = false; });
    }

    cancelRoomPairing() {
      this.roomClient.close(false);
      this.peerMatchStarted = false;
      this.pendingTournamentConfig = null;
      if (ui.peerDialog.open) ui.peerDialog.close();
    }

    showRoomError(message) {
      ui.peerError.textContent = message;
      ui.peerError.hidden = false;
      ui.peerStatus.dataset.state = 'failed';
      ui.peerStatus.textContent = 'Connection failed';
    }

    handleRoomStatus(status, detail) {
      const labels = {
        connecting: 'Connecting',
        waiting: 'Waiting for player',
        connected: 'Connected',
        disconnected: 'Disconnected',
        failed: 'Connection failed',
        closed: 'Closed'
      };
      ui.peerStatus.dataset.state = status;
      ui.peerStatus.textContent = labels[status] || 'Not connected';
      if (status === 'failed') this.showRoomError(detail);
      if (this.isPeerTournament()) {
        ui.engineDot.className = `engine-dot ${status === 'connected' ? 'online' : status === 'connecting' || status === 'waiting' ? 'connecting' : 'offline'}`;
        ui.engineMessage.textContent = detail || labels[status] || 'Local tournament room';
      }
    }

    handleRoomMessage(type, payload) {
      if (type === 'room-ready') {
        if (this.roomClient.role !== 'host' || this.peerMatchStarted) return;
        const config = { ...this.pendingTournamentConfig, role: 'host', opponent: 'peer' };
        this.peerMatchStarted = true;
        this.startTournament(config, { keepRoom: true });
        this.roomClient.send('game-start', {
          hostColor: config.playerColor,
          timeControl: config.value
        });
        return;
      }
      if (type === 'game-start') {
        if (this.roomClient.role !== 'guest' || this.peerMatchStarted) return;
        const allowedControls = new Set(['1|0', '3|2', '5|0', '10|0']);
        const hostColor = payload.hostColor === 'b' ? 'b' : 'w';
        const timeControl = allowedControls.has(payload.timeControl) ? payload.timeControl : '5|0';
        this.peerMatchStarted = true;
        this.startTournament({
          opponent: 'peer',
          role: 'guest',
          playerColor: hostColor === 'w' ? 'b' : 'w',
          ...this.getTimeControl(timeControl)
        }, { keepRoom: true });
        return;
      }
      if (type === 'move') this.receiveRoomMove(payload);
      if (type === 'clock') this.receiveRoomClock(payload);
      if (type === 'timeout') this.handleTimeout(payload.color, true);
      if (type === 'restart' && this.isPeerTournament()) this.resetTournamentBoard(false);
      if (type === 'sync-error' && this.isPeerTournament()) {
        this.clock?.stop();
        this.tournament.connectionLost = true;
        this.clearSelection(false);
        this.render();
        ui.hint.textContent = 'The two boards lost synchronization. Start a new network match.';
        this.showToast('Network match synchronization stopped.');
      }
      if (type === 'peer-left' && this.isPeerTournament()) {
        this.clock?.stop();
        this.tournament.connectionLost = true;
        this.clearSelection(false);
        this.render();
        ui.hint.textContent = 'The other player left the tournament room.';
        this.showToast('Network match disconnected.');
      }
    }

    receiveRoomMove(payload) {
      if (!this.isPeerTournament() || this.isGameOver() || payload.beforeFen !== this.game.fen() || this.game.turn !== this.opponentColor()) {
        this.roomClient.send('sync-error', { fen: this.game.fen() });
        return;
      }
      const move = this.game.moveFromUci(payload.uci);
      if (!move) {
        this.roomClient.send('sync-error', { fen: this.game.fen() });
        return;
      }
      this.commitMove(move, 'peer');
    }

    receiveRoomClock(payload) {
      if (!this.isPeerTournament() || !this.tournament.waitingForRemoteClock) return;
      const white = Number(payload.white);
      const black = Number(payload.black);
      if (!Number.isFinite(white) || !Number.isFinite(black)) return;
      this.tournament.waitingForRemoteClock = false;
      this.clock.sync({
        white: Math.min(this.tournament.baseMs + this.tournament.incrementMs * 200, white),
        black: Math.min(this.tournament.baseMs + this.tournament.incrementMs * 200, black),
        activeColor: this.playerColor()
      });
      this.renderClocks();
      ui.hint.textContent = 'Your clock is running. Touch a piece to begin your move.';
    }

    refreshEngineProfile() {
      if (this.engineKind() === 'peer') {
        ui.selectedEngineName.textContent = 'Another device';
        ui.selectedEngineStats.textContent = `Local WebSocket room · code ${this.roomClient.room || 'pending'} · no cloud service`;
        return;
      }
      const custom = this.engineKind() === 'custom';
      const depth = ui.depth.value;
      ui.selectedEngineName.textContent = this.engineName();
      const base = custom
        ? `Classical evaluation · depth ${depth}`
        : `Local UCI bridge · ${this.isCoach() ? 'grounded coach analysis' : 'tournament engine'} · depth ${depth}`;
      ui.selectedEngineStats.textContent = this.lastEngineStats ? `${base} · ${this.lastEngineStats}` : base;
    }
    setEngineControls() {
      $('tournament-reconnect').hidden = !this.isTournament() || this.engineKind() !== 'stockfish' || this.engine.status !== 'offline' || this.isGameOver();
      ui.analysisCard.hidden = this.isTournament() || this.isCoach() || this.isOpeningPrep();
      ui.coachCard.hidden = !this.isCoach();
      ui.openingCard.hidden = !this.isOpeningPrep();
      ui.engineModeSection.hidden = this.isOpeningPrep();
      ui.openingControls.hidden = !this.isOpeningPrep();
      ui.coachDot.className = `engine-dot ${this.engine.status === 'online' ? 'online' : this.engine.status === 'connecting' ? 'connecting' : 'offline'}`;
      ui.coachConnect.disabled = this.engine.status !== 'offline';
      ui.coachConnect.textContent = this.engine.status === 'online' ? 'Stockfish connected' : this.engine.status === 'connecting' ? 'Connecting…' : 'Connect Stockfish';
      if (this.isOpeningPrep()) return;
      const peer = this.engineKind() === 'peer';
      ui.depthControl.hidden = peer;
      ui.analysisCardTitle.textContent = peer ? 'Device connection' : 'Position analysis';
      if (peer) {
        ui.engineSectionTitle.textContent = 'Tournament opponent';
        ui.engineSelectLabel.textContent = 'Opponent';
        ui.opponentDescription.textContent = `${this.opponentName()} plays ${this.opponentColor() === 'w' ? 'White' : 'Black'} through the local tournament room.`;
        this.refreshEngineProfile();
        ui.engineLabel.textContent = 'Local network';
        ui.engineDot.className = `engine-dot ${this.roomClient.status === 'connected' ? 'online' : 'offline'}`;
        ui.engineDot.title = this.roomClient.status === 'connected' ? 'Other device connected' : 'Other device disconnected';
        ui.engineMessage.textContent = this.roomClient.status === 'connected' ? 'Both devices are connected through the host computer.' : 'Waiting for the other device.';
        ui.evalScore.textContent = '↔';
        ui.evalMeter.style.width = '50%';
        ui.pv.textContent = `Room ${this.roomClient.room || 'pending'} · moves and clocks stay on the local network.`;
        ui.connect.disabled = true;
        ui.connect.textContent = this.roomClient.status === 'connected' ? 'Device connected' : 'Waiting for device';
        return;
      }
      const custom = this.engineKind() === 'custom';
      const key = custom ? 'custom' : 'stockfish';
      const minDepth = custom ? 1 : 2;
      const maxDepth = custom ? 4 : 20;
      const depth = Math.max(minDepth, Math.min(maxDepth, this.depthSettings[key]));
      ui.depth.min = String(minDepth);
      ui.depth.max = String(maxDepth);
      ui.depth.value = String(depth);
      ui.depthValue.textContent = String(depth);
      ui.engineSectionTitle.textContent = this.isTournament() ? 'Tournament opponent' : this.isCoach() ? 'Coach engine' : 'Analysis';
      ui.engineSelectLabel.textContent = this.isTournament() ? 'Opponent engine' : this.isCoach() ? 'Grounding engine' : 'Analysis engine';
      ui.opponentDescription.textContent = this.isTournament()
        ? `${this.engineName()} plays ${this.opponentColor() === 'w' ? 'White' : 'Black'} in this timed match.`
        : this.isCoach() ? 'Stockfish grounds every verdict and projected line locally.'
          : custom ? 'Use CustomChessEngine for local classical analysis.' : 'Use Stockfish for local position analysis.';
      this.refreshEngineProfile();
      ui.engineLabel.textContent = this.engineName();
      if (custom) {
        ui.engineDot.className = 'engine-dot online';
        ui.engineDot.title = 'CustomChessEngine ready';
        ui.engineMessage.textContent = this.isTournament()
          ? 'The custom engine is ready to play.'
          : 'Static board score in pawns. Positive favors White.';
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
          : 'Start the local Stockfish bridge or select CustomChessEngine.';
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
      if (this.isCoach()) this.coach.start(this.game);
    }

    handleCameraKey(event, isDown) {
      const target = event.target;
      if (!isDown) this.cameraState.pressed.delete(event.code);
      if (!this.renderer.solidScene?.available || !ui.menu.hidden || target.closest?.('button, a, input, select, textarea, [contenteditable="true"]') || ui.promotion.open || ui.rules.open || ui.peerDialog.open) return;
      const keys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyI', 'KeyJ', 'KeyK', 'KeyL', 'Space', 'ShiftLeft', 'ShiftRight']);
      if (!keys.has(event.code)) return;
      event.preventDefault();
      if (isDown) this.cameraState.pressed.add(event.code);
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

    startVariationPreview(variation, label) {
      if (!variation?.frames?.length) return;
      this.clearSelection(false);
      this.preview = { variation, label, index: 0 };
      ui.variationControls.hidden = false;
      this.showVariationFrame();
    }
    stepVariation(delta) {
      if (!this.preview) return;
      this.preview.index = Math.max(0, Math.min(this.preview.variation.frames.length - 1, this.preview.index + delta));
      this.showVariationFrame();
    }
    showVariationFrame() {
      if (!this.preview) return;
      const frame = this.preview.variation.frames[this.preview.index];
      this.renderer.setGame(new ChessGame(frame.fen));
      ui.variationPrevious.disabled = this.preview.index === 0;
      ui.variationNext.disabled = this.preview.index >= this.preview.variation.frames.length - 1;
      ui.variationLabel.textContent = `${this.preview.label} · ${this.preview.index}/${this.preview.variation.frames.length - 1}${frame.san ? ` · ${frame.san}` : ''}`;
      ui.hint.textContent = this.preview.index ? `Projected position after ${frame.san}.` : 'Starting position for this projected line.';
    }
    exitVariationPreview(render = true) {
      if (!this.preview) return;
      this.preview = null;
      ui.variationControls.hidden = true;
      if (render) {
        this.renderer.setGame(this.game);
        ui.hint.textContent = this.isCoach() ? 'Returned to the live position.' : 'Returned to the game.';
      }
    }

    isPlayerTurnReady() {
      return this.isTournament() && !this.isGameOver() && !this.engineThinking && !this.tournament.awaitingClockPress && !this.tournament.waitingForEngine && !this.tournament.waitingForRemoteClock && !this.tournament.connectionLost && (!this.isPeerTournament() || this.roomClient.status === 'connected') && this.game.turn === this.playerColor() && this.clock?.activeColor === this.playerColor();
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
      if (this.preview || this.isTournament() || this.engineThinking || this.pendingPromotion || this.isGameOver()) return;
      if (this.isOpeningPrep() && !this.openingPrep.canInteract()) {
        this.showToast(this.openingPrep.isLearn() ? 'Use Next move to step through this lesson.' : 'Wait for the prepared reply.');
        return;
      }
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

    commitMove(move, source = 'local') {
      const beforeFen = this.game.fen();
      const uci = moveToUci(move);
      if (this.isOpeningPrep() && source === 'local' && !this.openingPrep.acceptsMove(move)) return;
      const { san } = this.game.apply(move);
      const entry = this.game.history.at(-1);
      this.clearSelection(false);
      if (this.isPeerTournament() && source === 'local') {
        this.roomClient.send('move', { uci, beforeFen });
      }
      if (this.isCoach()) this.coach.onMove(this.game, entry, this.game.history.length - 1);
      if (this.isOpeningPrep()) this.openingPrep.afterMove(entry, source);
      if (this.game.result) {
        this.clock?.stop();
        this.analyse();
        this.render();
        ui.hint.textContent = this.game.result;
        this.showToast(this.game.result);
        return;
      }
      this.render();
      if (this.isTournament()) {
        if (source === 'engine') this.completeEngineTurn(san);
        else if (source === 'peer') {
          this.tournament.waitingForRemoteClock = true;
          ui.hint.textContent = `${this.opponentName()} played ${san}. Waiting for their clock press…`;
        } else this.awaitPlayerClockPress(san);
      } else if (!this.isOpeningPrep()) {
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
      this.clock.start(this.opponentColor());
      this.renderClocks();
      if (this.isPeerTournament()) {
        const snapshot = this.clock.snapshot();
        this.roomClient.send('clock', { white: snapshot.white, black: snapshot.black });
        ui.hint.textContent = 'Waiting for the other player’s move…';
      } else {
        ui.hint.textContent = `${this.opponentName()} is considering the position…`;
        this.maybeEngineTurn();
      }
    }
    completeEngineTurn(san) {
      if (this.isGameOver()) return;
      if (!this.clock.press(this.opponentColor())) return;
      this.clock.start(this.playerColor());
      this.renderClocks();
      ui.hint.textContent = `${this.opponentName()} played ${san} and pressed the clock. Your move.`;
    }
    handleTimeout(color, fromPeer = false) {
      if (!this.isTournament() || this.timeoutResult) return;
      const winner = color === 'w' ? 'Black' : 'White';
      this.timeoutResult = `${winner} wins by timeout`;
      this.cancelEngineSearch();
      this.clearSelection(false);
      this.render();
      ui.hint.textContent = this.timeoutResult;
      this.showToast(this.timeoutResult);
      if (this.isPeerTournament() && !fromPeer) this.roomClient.send('timeout', { color });
    }

    maybeEngineTurn() {
      if (!this.isTournament() || this.isPeerTournament() || this.isGameOver() || this.tournament.awaitingClockPress || this.tournament.waitingForEngine) return;
      const engineColor = this.opponentColor();
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
          this.commitMove(move, 'engine');
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
      this.exitVariationPreview(false);
      if (this.isOpeningPrep()) {
        this.openingPrep.reset();
        this.showToast('Opening lesson restarted.');
        return;
      }
      if (this.isTournament()) {
        if (this.isPeerTournament()) {
          this.resetTournamentBoard(true);
          this.showToast('Network tournament restarted on both devices.');
          return;
        }
        const config = { ...this.tournament };
        this.startTournament(config);
        this.showToast('Tournament restarted with the same match settings.');
        return;
      }
      this.cancelEngineSearch();
      this.game.reset(); this.timeoutResult = null; this.clearSelection(false);
      if (this.isCoach()) this.coach.clear();
      this.render();
      ui.hint.textContent = this.isCoach() ? 'New coaching game ready. Play a move for feedback.' : 'New analysis board ready. White to move.';
      this.analyse();
      if (this.isCoach()) this.coach.start(this.game);
    }
    resetTournamentBoard(broadcast) {
      if (!this.isPeerTournament()) return;
      this.game.reset();
      this.timeoutResult = null;
      this.tournament.awaitingClockPress = false;
      this.tournament.waitingForRemoteClock = false;
      this.tournament.connectionLost = false;
      this.clearSelection(false);
      this.clock.reset();
      this.clock.start('w');
      this.render();
      ui.hint.textContent = this.playerColor() === 'w' ? 'Your clock is running. Touch a piece to begin your move.' : 'Waiting for the other player’s move…';
      if (broadcast) this.roomClient.send('restart');
    }
    undo() {
      if (this.isTournament()) { this.showToast('Take-backs are disabled in tournament simulation.'); return; }
      this.exitVariationPreview(false);
      if (this.isOpeningPrep()) {
        if (this.openingPrep.isLearn()) this.openingPrep.stepLearn(-1); else this.openingPrep.reset();
        this.showToast(this.openingPrep.isLearn() ? 'Moved back one lesson step.' : 'Practice line restarted.');
        return;
      }
      if (!this.game.undo()) { this.showToast('There is no move to take back.'); return; }
      this.clearSelection(false); this.render(); this.analyse(); this.showToast('Move taken back.');
      if (this.isCoach()) this.coach.onUndo(this.game);
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
    resetEvaluation(line = '') {
      ui.evalScore.textContent = '—';
      ui.evalMeter.style.width = '50%';
      ui.pv.textContent = line;
      this.lastEngineStats = '';
      this.refreshEngineProfile();
    }
    async analyse() {
      if (this.appMode !== 'analysis' || !ui.menu.hidden) return;
      this.cancelEngineSearch();
      this.analysisRequestId = null;
      this.resetEvaluation(this.game.result || '');
      if (this.game.result) return;
      const fen = this.game.fen();
      const depth = Number(ui.depth.value);
      if (this.engineKind() === 'stockfish') {
        if (this.engine.status === 'online') {
          ui.pv.textContent = 'Searching for a continuation…';
          this.analysisRequestId = this.engine.analyse(fen, depth);
        }
        return;
      }
      const token = this.engineRequestToken;
      ui.pv.textContent = 'Searching for a move…';
      try {
        const result = await this.customEngine.chooseMove(this.game, depth);
        if (token !== this.engineRequestToken) return;
        if (!result) { ui.pv.textContent = 'No legal move.'; return; }
        const line = window.TournamentCoachVariation.build(fen, result.move, 1);
        ui.pv.textContent = line.san ? `Suggested move: ${line.san} (${result.move})` : 'No legal suggestion for this position.';
        ui.evalScore.textContent = `${result.score >= 0 ? '+' : ''}${result.score.toFixed(2)}`;
        ui.evalMeter.style.width = `${Math.max(4, Math.min(96, 50 + result.score * 100 / 24))}%`;
        this.lastEngineStats = `${result.nodes.toLocaleString()} nodes · ${Math.round(result.elapsedMs)} ms`;
        this.refreshEngineProfile();
      } catch (error) {
        if (token === this.engineRequestToken) ui.pv.textContent = error.message;
      }
    }
    connectEngine(silent = false) {
      if (this.engineKind() === 'peer') { this.showToast('The other device connects through the tournament room.'); return; }
      if (this.engineKind() === 'custom') { this.showToast('The custom engine runs locally in this browser.'); return; }
      this.engine.connect().then(() => {
        if (!ui.menu.hidden || this.engineKind() !== 'stockfish') return;
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
        const awaiting = player && this.tournament.awaitingClockPress && !this.tournament.waitingForEngine && !this.isGameOver();
        button.disabled = !awaiting;
        button.className = `chess-clock ${color === 'w' ? 'white-clock' : 'black-clock'}${snapshot.activeColor === color ? ' active' : ''}${awaiting ? ' awaiting' : ''}`;
        button.setAttribute('aria-label', `${color === 'w' ? 'White' : 'Black'} clock: ${this.formatClock(color === 'w' ? snapshot.white : snapshot.black)}${awaiting ? '. Press to end your turn.' : ''}`);
      });
    }
    render() {
      if (this.preview) this.showVariationFrame(); else this.renderer.setGame(this.game);
      this.renderHeader();
      this.renderMoves();
      this.renderClocks();
      ui.fen.textContent = this.game.fen();
    }
    renderHeader() {
      const result = this.resultText();
      const title = this.isTournament() ? `Tournament · vs ${this.engineName()}` : this.isCoach() ? 'AI coach' : this.isOpeningPrep() ? 'Opening Prep' : 'Analysis board';
      ui.title.textContent = result || title;
      const turnColor = this.game.turn === 'w' ? 'white-piece' : 'black-piece';
      const turnIcon = this.game.turn === 'w' ? '♔' : '♚';
      ui.turn.innerHTML = `<span class="turn-piece ${turnColor}">${turnIcon}</span><span>${result || `${this.game.turn === 'w' ? 'White' : 'Black'} to move`}</span>`;
      ui.sessionStatus.innerHTML = this.isTournament()
        ? `<span class="pulse"></span> ${this.isPeerTournament() ? `Network room ${this.roomClient.room}` : 'Tournament simulation'} · ${this.tournament.label}`
        : `<span class="pulse"></span> ${this.isCoach() ? 'AI coach' : this.isOpeningPrep() ? 'Opening Prep' : 'Practice table'} · Local session`;
    }
    renderMoves() {
      if (!this.game.history.length) { ui.moveList.innerHTML = '<p class="empty-moves">Your moves will be recorded here.</p>'; return; }
      ui.moveList.replaceChildren();
      for (let i = 0; i < this.game.history.length; i += 2) {
        const row = document.createElement('div'); row.className = 'move-row';
        const number = document.createElement('span'); number.className = 'move-number'; number.textContent = `${Math.floor(i / 2) + 1}.`;
        const white = document.createElement('span'); white.className = `move-san ${i === this.game.history.length - 1 ? 'latest' : ''}`; white.textContent = this.game.history[i]?.san || '';
        const black = document.createElement('span'); black.className = `move-san ${i + 1 === this.game.history.length - 1 ? 'latest' : ''}`; black.textContent = this.game.history[i + 1]?.san || '';
        if (this.isCoach() && this.game.history[i]) { white.classList.add('reviewable'); white.tabIndex = 0; white.addEventListener('click', () => this.coach.selectMove(i)); white.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') this.coach.selectMove(i); }); }
        if (this.isCoach() && this.game.history[i + 1]) { black.classList.add('reviewable'); black.tabIndex = 0; black.addEventListener('click', () => this.coach.selectMove(i + 1)); black.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') this.coach.selectMove(i + 1); }); }
        row.append(number, white, black); ui.moveList.append(row);
      }
      ui.moveList.scrollTop = ui.moveList.scrollHeight;
    }
    save() {
      this.storage.downloadPgn(this.game);
      try {
        this.storage.saveSession(this.game, { mode: this.appMode, engine: this.engineKind(), depth: ui.depth.value, tournament: this.isTournament() ? { opponent: this.tournament.opponent, playerColor: this.playerColor(), timeControl: this.tournament.value } : null });
        this.showToast('Saved locally and exported as a PGN file.');
      } catch { this.showToast('PGN exported. Browser storage is unavailable for session recovery.'); }
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
