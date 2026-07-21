/* Coordinates engine analysis, deterministic features, and coach presentation. */
(function () {
  'use strict';

  const { AnalysisCoordinator } = window.TournamentCoachAnalysis;
  const Position = window.TournamentCoachPosition;
  const Variation = window.TournamentCoachVariation;
  const Explanation = window.TournamentCoachExplanation;

  function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  class CoachController {
    constructor({ engine, getDepth, ui, onPreview }) {
      this.engine = engine;
      this.getDepth = getDepth;
      this.ui = ui;
      this.onPreview = onPreview;
      this.analysis = new AnalysisCoordinator(engine);
      this.reports = new Map();
      this.position = null;
      this.selectedMoveIndex = null;
      this.tab = 'move';
      this.token = 0;
      ui.moveTab.addEventListener('click', () => this.showTab('move'));
      ui.positionTab.addEventListener('click', () => this.showTab('position'));
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
        this.position = Explanation.positionReport(afterFeatures, afterAnalysis);
        if (token === this.token) {
          this.setStatus(`Coach report ready · depth ${afterAnalysis.depth || depth}`, 'ready');
          this.renderActive();
        }
      }).catch(error => {
        if (token !== this.token) return;
        this.setStatus(error.message || 'The coach could not grade this move.', 'offline');
        this.renderMovePlaceholder('The move is recorded, but its engine verdict is unavailable.');
      });
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
      this.ui.body.replaceChildren(verdict, reasons, forecast, chosenLine, actions);
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
      this.ui.body.replaceChildren(header, columns, details);
    }
  }

  window.TournamentCoach = { CoachController };
})();
