/* Coordinates engine analysis, deterministic features, and coach presentation. */
(function () {
  'use strict';

  const { AnalysisCoordinator } = window.TournamentCoachAnalysis;
  const Position = window.TournamentCoachPosition;
  const Variation = window.TournamentCoachVariation;
  const Explanation = window.TournamentCoachExplanation;
  const { CoachTrainingRecorder } = window.TournamentCoachTraining;
  const { ChessGame, moveToUci } = window.ChessDomain;

  function legalMovesForFen(fen) {
    const game = new ChessGame(fen);
    return game.allLegalMoves().flatMap(move => move.promotion
      ? ['q', 'r', 'b', 'n'].map(piece => moveToUci({ ...move, promotionChoice: piece }))
      : [moveToUci(move)]);
  }

  function probability(value) { return `${Math.round(Number(value || 0) * 100)}%`; }
  function conceptName(value) { return String(value || 'calculation').replaceAll('_', ' '); }
  function sanForUci(fen, uci) {
    if (!fen || !uci) return String(uci || '');
    try {
      const game = new ChessGame(fen);
      const move = game.moveFromUci(uci);
      if (!move) return uci;
      return game.apply(move).san || uci;
    } catch { return uci; }
  }

  function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  class CoachController {
    constructor({ engine, grounding = null, getDepth, ui, onPreview }) {
      this.engine = engine;
      this.grounding = grounding;
      this.getDepth = getDepth;
      this.ui = ui;
      this.onPreview = onPreview;
      this.analysis = new AnalysisCoordinator(engine);
      this.recorder = new CoachTrainingRecorder();
      this.reports = new Map();
      this.position = null;
      this.selectedMoveIndex = null;
      this.tab = 'move';
      this.token = 0;
      ui.moveTab.addEventListener('click', () => this.showTab('move'));
      ui.positionTab.addEventListener('click', () => this.showTab('position'));
      ui.exportData.addEventListener('click', () => this.recorder.download());
      this.refreshExportControl();
    }

    refreshExportControl() {
      const count = this.recorder.count();
      this.ui.exportData.disabled = count === 0;
      this.ui.exportData.textContent = count ? `Export model data · ${count}` : 'Export model data';
    }

    isOnline() { return this.engine.status === 'online'; }
    setStatus(message, state = '') {
      this.ui.status.textContent = message;
      this.ui.status.dataset.state = state;
    }

    start(game) {
      this.game = game;
      this.selectedMoveIndex = game.history.length ? game.history.length - 1 : null;
      if (this.selectedMoveIndex !== null && !this.reports.has(this.selectedMoveIndex) && this.isOnline()) {
        this.onMove(game, game.history[this.selectedMoveIndex], this.selectedMoveIndex);
        return;
      }
      this.analyzeCurrent(game);
      if (this.selectedMoveIndex !== null && !this.reports.has(this.selectedMoveIndex)) this.renderMovePlaceholder('Make another move or select Position while the coach prepares this game.');
      else this.renderActive();
    }

    stop() { this.token += 1; }
    clear() {
      this.reports.clear();
      this.position = null;
      this.selectedMoveIndex = null;
      this.analysis.clear();
      this.ui.body.replaceChildren();
    }

    showTab(tab) {
      this.tab = tab;
      this.ui.moveTab.classList.toggle('active', tab === 'move');
      this.ui.positionTab.classList.toggle('active', tab === 'position');
      this.renderActive();
    }

    analyzeCurrent(game) {
      const fen = game.fen();
      const features = Position.analyze(fen);
      this.position = Explanation.positionReport(features, null);
      if (!this.isOnline()) {
        this.setStatus('Static board features are ready. Connect Stockfish for evaluation and move grading.', 'offline');
        if (this.tab === 'position') this.renderPosition();
        return Promise.resolve(null);
      }
      const token = ++this.token;
      this.setStatus('Analyzing the current position…', 'thinking');
      return this.analysis.analyze(fen, this.getDepth(), 3).then(engineAnalysis => {
        if (token !== this.token) return engineAnalysis;
        this.position = Explanation.positionReport(features, engineAnalysis);
        this.setStatus(`Position ready · depth ${engineAnalysis.depth || this.getDepth()}`, 'ready');
        if (this.tab === 'position') this.renderPosition();
        this.requestPositionGrounding({ game, fen, features, engineAnalysis, token });
        return engineAnalysis;
      }).catch(error => {
        if (token !== this.token) return null;
        this.setStatus(error.message || 'The coach could not analyze this position.', 'offline');
        if (this.tab === 'position') this.renderPosition();
        return null;
      });
    }

    onMove(game, entry, historyIndex) {
      this.selectedMoveIndex = historyIndex;
      this.showTab('move');
      this.renderMovePlaceholder(`Reviewing ${entry.san}…`);
      const afterFeatures = Position.analyze(entry.fen);
      this.position = Explanation.positionReport(afterFeatures, null);
      if (!this.isOnline()) {
        this.setStatus('Move recorded. Connect Stockfish to receive a verdict.', 'offline');
        return;
      }
      const token = ++this.token;
      const depth = this.getDepth();
      this.setStatus(`Analyzing ${entry.san}…`, 'thinking');
      Promise.all([
        this.analysis.analyze(entry.beforeFen, depth, 3),
        this.analysis.analyze(entry.fen, depth, 3),
      ]).then(([beforeAnalysis, afterAnalysis]) => {
        const beforeFeatures = Position.analyze(entry.beforeFen);
        const chosenPv = [entry.uci, ...String(afterAnalysis.lines?.[0]?.pv || '').split(/\s+/).filter(Boolean)].join(' ');
        const chosenVariation = Variation.build(entry.beforeFen, chosenPv, 9);
        const bestVariation = Variation.build(entry.beforeFen, beforeAnalysis.lines?.[0]?.pv || '', 9);
        const report = Explanation.moveReport({ entry, beforeAnalysis, afterAnalysis, beforeFeatures, afterFeatures, chosenVariation, bestVariation });
        this.reports.set(historyIndex, report);
        this.recorder.record({ entry, beforeAnalysis, afterAnalysis, beforeFeatures, afterFeatures, report });
        this.refreshExportControl();
        this.position = Explanation.positionReport(afterFeatures, afterAnalysis);
        if (token === this.token) {
          this.setStatus(`Coach report ready · depth ${afterAnalysis.depth || depth}`, 'ready');
          this.renderActive();
        }
        this.requestMoveGrounding({
          entry, beforeAnalysis, afterAnalysis, beforeFeatures, afterFeatures,
          report, historyIndex,
        });
      }).catch(error => {
        if (token !== this.token) return;
        this.setStatus(error.message || 'The coach could not grade this move.', 'offline');
        this.renderMovePlaceholder('The move is recorded, but its engine verdict is unavailable.');
      });
    }

    requestMoveGrounding({ entry, beforeAnalysis, afterAnalysis, beforeFeatures, afterFeatures, report, historyIndex }) {
      if (!this.grounding) return;
      this.grounding.predictMove({
        entry, beforeAnalysis, afterAnalysis, beforeFeatures, afterFeatures,
        loss: report.loss,
        legalMoves: legalMovesForFen(entry.beforeFen),
      }).then(prediction => {
        if (this.reports.get(historyIndex) !== report) return;
        report.grounding = prediction;
        if (this.tab === 'move' && this.selectedMoveIndex === historyIndex) this.renderMove(report);
      }).catch(() => { /* The verified Stockfish report remains fully usable offline. */ });
    }

    requestPositionGrounding({ game, fen, features, engineAnalysis, token }) {
      if (!this.grounding) return;
      this.grounding.predictPosition({
        fen,
        analysis: engineAnalysis,
        features,
        mover: game.turn,
        legalMoves: legalMovesForFen(fen),
      }).then(prediction => {
        if (token !== this.token || (this.position?.fen && this.position.fen !== fen)) return;
        if (this.position) this.position.grounding = prediction;
        if (this.tab === 'position') this.renderPosition();
      }).catch(() => { /* Static features and Stockfish remain the fallback. */ });
    }

    onUndo(game) {
      [...this.reports.keys()].filter(index => index >= game.history.length).forEach(index => this.reports.delete(index));
      this.selectedMoveIndex = game.history.length ? game.history.length - 1 : null;
      this.analyzeCurrent(game);
      this.renderActive();
    }

    selectMove(index) {
      this.selectedMoveIndex = index;
      if (!this.reports.has(index) && this.game?.history[index] && this.isOnline()) {
        this.onMove(this.game, this.game.history[index], index);
        return;
      }
      this.showTab('move');
    }

    renderActive() {
      if (this.tab === 'position') this.renderPosition();
      else {
        const report = this.reports.get(this.selectedMoveIndex);
        if (report) this.renderMove(report);
        else this.renderMovePlaceholder(this.selectedMoveIndex === null ? 'Play a move to receive a coach report.' : 'This move has not been analyzed in the current session.');
      }
    }

    renderMovePlaceholder(message) {
      this.ui.body.replaceChildren(element('p', 'coach-empty', message));
    }

    renderMove(report) {
      const verdict = element('div', `coach-verdict grade-${report.verdict.toLowerCase()}`);
      verdict.append(element('strong', '', report.verdict), element('span', '', `${report.san} · ${report.beforeEvaluation} → ${report.afterEvaluation}`));
      const reasons = element('ul', 'coach-reasons');
      report.reasons.forEach(reason => reasons.append(element('li', '', reason)));
      const forecast = element('p', 'coach-forecast', report.forecast);
      const grounding = this.renderGrounding(report.grounding, report.verdict, report.chosenVariation?.startFen);
      const chosenLine = element('div', 'coach-line');
      chosenLine.append(element('span', 'coach-line-label', 'Projected response'), element('p', '', report.chosenVariation.san || 'No continuation returned.'));
      const actions = element('div', 'coach-actions');
      const previewChosen = element('button', 'text-button coach-preview', 'Preview played line');
      previewChosen.type = 'button';
      previewChosen.disabled = report.chosenVariation.frames.length < 2;
      previewChosen.addEventListener('click', () => this.onPreview(report.chosenVariation, `${report.san} projected line`));
      actions.append(previewChosen);
      if (!report.exactBest && report.bestVariation.frames.length > 1) {
        const previewBest = element('button', 'text-button coach-preview', 'Preview best line');
        previewBest.type = 'button';
        previewBest.addEventListener('click', () => this.onPreview(report.bestVariation, 'Engine best line'));
        actions.append(previewBest);
      }
      this.ui.body.replaceChildren(verdict, reasons, forecast, grounding, chosenLine, actions);
    }

    renderGrounding(prediction, verifiedVerdict = '', fen = '') {
      const panel = element('div', 'coach-grounding');
      if (!prediction) { panel.hidden = true; return panel; }
      const concept = prediction.concepts?.[0];
      const verdict = prediction.verdict;
      const signals = element('ul');
      if (concept) signals.append(element('li', '', `Strategic theme: ${conceptName(concept.name)} (${probability(concept.probability)} confidence).`));
      if (verdict) {
        const comparison = verdict.name === verifiedVerdict
          ? `agrees with Stockfish's ${verifiedVerdict} verdict`
          : `estimates ${verdict.name}; Stockfish grades the move ${verifiedVerdict}`;
        signals.append(element('li', '', `Move verdict: ${comparison} (${probability(verdict.probability)} confidence).`));
      }
      const played = prediction.policy?.played;
      const top = prediction.policy?.top?.[0];
      if (played) {
        signals.append(element('li', '', `Policy rank: ${sanForUci(fen, played.uci)} is ${played.rank} of ${prediction.policy.legalMoveCount} legal moves (${probability(played.probability)}).`));
      }
      if (top && (!played || top.uci !== played.uci)) {
        signals.append(element('li', '', `Highest learned move signal: ${sanForUci(fen, top.uci)} (${probability(top.probability)}).`));
      }
      if (!verdict && prediction.wdl) {
        signals.append(element('li', '', `Side-to-move outlook: win ${probability(prediction.wdl.win)}, draw ${probability(prediction.wdl.draw)}, loss ${probability(prediction.wdl.loss)}.`));
      }
      panel.append(element('strong', '', 'Neural grounding'), signals, element('p', 'coach-grounding-note', 'Advisory model signal. Stockfish and verified board facts remain authoritative.'));
      return panel;
    }

    renderPosition() {
      if (!this.position) { this.ui.body.replaceChildren(element('p', 'coach-empty', 'Position features are not ready yet.')); return; }
      const header = element('div', 'position-overview');
      header.append(element('strong', '', this.position.evaluation), element('p', '', this.position.headline));
      const columns = element('div', 'position-sides');
      [['White', this.position.white], ['Black', this.position.black]].forEach(([name, advantages]) => {
        const section = element('section', 'position-side');
        section.append(element('h3', '', name));
        const list = element('ul');
        advantages.forEach(item => list.append(element('li', '', item)));
        section.append(list); columns.append(section);
      });
      const details = element('dl', 'position-details');
      Object.entries(this.position.details).forEach(([name, value]) => {
        details.append(element('dt', '', name), element('dd', '', value));
      });
      this.ui.body.replaceChildren(header, columns, this.renderGrounding(this.position.grounding, '', this.position.fen), details);
    }
  }

  window.TournamentCoach = { CoachController };
})();
