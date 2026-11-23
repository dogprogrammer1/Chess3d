/* Guided local opening lessons and repertoire practice. */
(function () {
  'use strict';

  const { START_FEN, moveToUci } = window.ChessDomain;
  const Variation = window.TournamentCoachVariation;
  const PROGRESS_KEY = 'tournament-room.opening-progress.v1';

  class OpeningPrepController {
    constructor({ ui, onChange, onHint }) {
      this.ui = ui;
      this.onChange = onChange;
      this.onHint = onHint;
      this.openings = [];
      this.opening = null;
      this.chapter = null;
      this.game = null;
      this.token = 0;
      this.progress = this.loadProgress();
      this.sessionAttempts = 0;
      this.sessionCorrect = 0;
      ui.opening.addEventListener('change', () => this.selectOpening());
      ui.chapter.addEventListener('change', () => this.selectChapter());
      ui.side.addEventListener('change', () => this.reset());
      ui.workflow.addEventListener('change', () => this.reset());
      ui.previous.addEventListener('click', () => this.stepLearn(-1));
      ui.next.addEventListener('click', () => this.stepLearn(1));
      ui.restart.addEventListener('click', () => this.reset());
    }

    loadProgress() {
      try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}'); } catch { return {}; }
    }
    saveProgress() {
      try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(this.progress)); }
      catch { /* The current session still tracks completed lessons. */ }
    }

    async load() {
      if (this.openings.length) return;
      const response = await fetch('data/openings/openings.json');
      if (!response.ok) throw new Error('Opening lessons could not be loaded.');
      const data = await response.json();
      this.openings = data.openings || [];
      this.ui.opening.replaceChildren(...this.openings.map(opening => {
        const option = document.createElement('option'); option.value = opening.id; option.textContent = `${opening.eco} · ${opening.name}`; return option;
      }));
    }

    async start(game) {
      const token = ++this.token;
      this.game = game;
      this.ui.feedback.textContent = 'Loading opening curriculum…';
      try {
        await this.load();
        if (token === this.token) this.selectOpening();
      } catch (error) {
        if (token !== this.token) return;
        this.ui.feedback.textContent = error.message;
        this.onHint(error.message);
      }
    }

    stop() { this.token += 1; }
    selectOpening() {
      this.opening = this.openings.find(item => item.id === this.ui.opening.value) || this.openings[0];
      if (!this.opening) return;
      this.ui.opening.value = this.opening.id;
      this.ui.chapter.replaceChildren(...this.opening.chapters.map(chapter => {
        const option = document.createElement('option'); option.value = chapter.id; option.textContent = chapter.title; return option;
      }));
      this.chapter = this.opening.chapters[0];
      this.ui.chapter.value = this.chapter.id;
      this.reset();
    }
    selectChapter() {
      this.chapter = this.opening.chapters.find(item => item.id === this.ui.chapter.value) || this.opening.chapters[0];
      this.reset();
    }
    isLearn() { return this.ui.workflow.value === 'learn'; }
    learnerSide() { return this.ui.side.value === 'b' ? 'b' : 'w'; }
    canInteract() { return Boolean(this.chapter) && !this.isLearn() && this.game?.turn === this.learnerSide() && this.game.history.length < this.chapter.moves.length; }

    reset() {
      if (!this.game || !this.chapter) return;
      this.token += 1;
      this.sessionAttempts = 0;
      this.sessionCorrect = 0;
      this.game.reset();
      this.ui.feedback.textContent = this.isLearn() ? 'Step through the line and connect each move to its key idea.' : `Practice as ${this.learnerSide() === 'w' ? 'White' : 'Black'}. Play the highlighted lesson line from memory.`;
      this.render();
      this.onChange();
      if (!this.isLearn()) this.scheduleOpponent();
    }

    expectedMove() { return this.chapter?.moves[this.game.history.length] || ''; }
    acceptsMove(move) {
      if (!this.canInteract()) return false;
      this.sessionAttempts += 1;
      const uci = moveToUci(move);
      if (uci === this.expectedMove()) { this.sessionCorrect += 1; return true; }
      const prefix = this.game.history.map(entry => entry.uci);
      const alternate = this.opening.chapters.find(chapter => chapter.moves.slice(0, prefix.length).every((candidate, index) => candidate === prefix[index]) && chapter.moves[prefix.length] === uci);
      if (alternate) {
        this.chapter = alternate;
        this.ui.chapter.value = alternate.id;
        this.sessionCorrect += 1;
        this.ui.feedback.textContent = `That enters ${alternate.title}; the lesson has switched to that branch.`;
        return true;
      }
      this.ui.feedback.textContent = 'That move is legal, but it leaves this lesson’s repertoire. Try the prepared move or switch chapters.';
      this.onHint(this.ui.feedback.textContent);
      return false;
    }

    afterMove(entry, source = 'local') {
      const ply = this.game.history.length;
      if (source === 'local') this.ui.feedback.textContent = `Correct: ${entry.san}. ${this.ideaForPly(ply)}`;
      else this.onHint(`${entry.san} is the prepared reply. Your turn to continue the lesson.`);
      if (ply >= this.chapter.moves.length) {
        this.progress[`${this.opening.id}:${this.chapter.id}:${this.learnerSide()}`] = { completedAt: new Date().toISOString(), attempts: this.sessionAttempts, correct: this.sessionCorrect };
        this.saveProgress();
        this.ui.feedback.textContent = `Line complete. ${this.chapter.summary}`;
        this.onHint('Opening lesson complete. Restart it or choose another chapter.');
      }
      this.render();
      this.onChange();
      if (!this.isLearn()) this.scheduleOpponent();
    }

    scheduleOpponent() {
      if (!this.game || this.isLearn() || this.game.history.length >= this.chapter.moves.length || this.game.turn === this.learnerSide()) return;
      const token = ++this.token;
      this.onHint(`${this.opening.name} lesson is choosing the prepared reply…`);
      setTimeout(() => {
        if (token !== this.token || this.isLearn()) return;
        const move = this.game.moveFromUci(this.expectedMove());
        if (!move) { this.ui.feedback.textContent = 'This lesson contains an invalid continuation.'; return; }
        const result = this.game.apply(move);
        const entry = this.game.history.at(-1);
        this.ui.feedback.textContent = `${result.san}. ${this.ideaForPly(this.game.history.length)}`;
        this.afterMove(entry, 'opening');
      }, 360);
    }

    stepLearn(delta) {
      if (!this.game || !this.chapter || !this.isLearn()) return;
      const target = Math.max(0, Math.min(this.chapter.moves.length, this.game.history.length + delta));
      this.token += 1;
      this.game.reset();
      for (let index = 0; index < target; index += 1) {
        const move = this.game.moveFromUci(this.chapter.moves[index]);
        if (!move) break;
        this.game.apply(move);
      }
      this.ui.feedback.textContent = target ? this.ideaForPly(target) : this.chapter.introduction;
      this.render();
      this.onChange();
    }

    ideaForPly(ply) {
      const anchored = this.chapter.anchors?.find(anchor => anchor.ply === ply);
      const section = Math.min(this.chapter.ideas.length - 1, Math.floor(Math.max(0, ply - 1) * this.chapter.ideas.length / this.chapter.moves.length));
      return anchored?.text || this.chapter.ideas[section];
    }

    render() {
      if (!this.opening || !this.chapter) return;
      this.ui.title.textContent = `${this.opening.eco} · ${this.opening.name}`;
      this.ui.chapterTitle.textContent = this.chapter.title;
      this.ui.description.textContent = this.chapter.introduction;
      this.ui.ideas.replaceChildren(...this.chapter.ideas.map(idea => { const item = document.createElement('li'); item.textContent = idea; return item; }));
      const variation = Variation.build(START_FEN, this.chapter.moves, 40);
      this.ui.line.textContent = this.isLearn() ? variation.san : 'Prepared line hidden during practice.';
      const ply = this.game?.history.length || 0;
      const accuracy = !this.isLearn() && this.sessionAttempts ? ` · ${Math.round(this.sessionCorrect / this.sessionAttempts * 100)}%` : '';
      this.ui.progress.textContent = `${ply}/${this.chapter.moves.length} plies${accuracy}${this.progress[`${this.opening.id}:${this.chapter.id}:${this.learnerSide()}`] ? ' · completed' : ''}`;
      this.ui.previous.disabled = !this.isLearn() || ply === 0;
      this.ui.next.disabled = !this.isLearn() || ply >= this.chapter.moves.length;
    }
  }

  window.TournamentOpeningPrep = { OpeningPrepController };
})();
