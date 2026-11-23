/* Stores versioned, model-ready coach examples locally and exports JSONL. */
(function () {
  'use strict';

  const KEY = 'tournament-room.coach-training.v1';
  const SCHEMA = 'tournament-room.coach-example.v1';

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function compactAnalysis(analysis) {
    const lines = Array.isArray(analysis?.lines) ? analysis.lines.slice(0, 5) : [];
    return {
      fen: analysis?.fen || '',
      depth: Number(analysis?.depth || lines[0]?.depth || 0),
      lines: lines.map(line => ({
        rank: Number(line.rank || 1),
        scoreType: line.scoreType === 'mate' ? 'mate' : 'cp',
        score: Number(line.score || 0),
        wdl: Array.isArray(line.wdl) ? line.wdl.slice(0, 3).map(Number) : [],
        pv: String(line.pv || ''),
        depth: Number(line.depth || analysis?.depth || 0),
        nodes: Number(line.nodes || 0),
      })),
    };
  }

  function compactVariation(variation) {
    return {
      startFen: variation?.startFen || '',
      san: variation?.san || '',
      projectedFen: variation?.projectedFen || '',
      frames: (variation?.frames || []).map(frame => ({ uci: frame.uci, san: frame.san, fen: frame.fen, ply: frame.ply })),
    };
  }

  function buildExample({ entry, beforeAnalysis, afterAnalysis, beforeFeatures, afterFeatures, report }) {
    return {
      schema: SCHEMA,
      createdAt: new Date().toISOString(),
      position: { beforeFen: entry.beforeFen, afterFen: entry.fen },
      move: { uci: entry.uci, san: entry.san, mover: entry.move.piece.color },
      player: { rating: null },
      engine: { before: compactAnalysis(beforeAnalysis), after: compactAnalysis(afterAnalysis) },
      features: { before: clone(beforeFeatures), after: clone(afterFeatures) },
      variations: { played: compactVariation(report.chosenVariation), best: compactVariation(report.bestVariation) },
      target: {
        verdict: report.verdict,
        loss: Number(report.loss || 0),
        exactBest: Boolean(report.exactBest),
        bestUci: report.bestUci || '',
        beforeEvaluation: report.beforeEvaluation,
        afterEvaluation: report.afterEvaluation,
        primaryConcept: report.primaryConcept || 'calculation',
        evidence: clone(report.evidence || []),
        reasons: [...report.reasons],
        forecast: report.forecast,
      },
    };
  }

  class CoachTrainingRecorder {
    constructor(storage, limit = 200) {
      try { this.storage = storage === undefined ? window.localStorage : storage; }
      catch { this.storage = null; }
      this.limit = limit;
      this.examples = this.load();
    }

    load() {
      try {
        const value = JSON.parse(this.storage.getItem(KEY) || '[]');
        return Array.isArray(value) ? value.filter(example => example?.schema === SCHEMA) : [];
      } catch { return []; }
    }

    persist() {
      try { this.storage.setItem(KEY, JSON.stringify(this.examples)); }
      catch { /* A full or unavailable browser store must not interrupt coaching. */ }
    }

    record(input) {
      const example = buildExample(input);
      const key = `${example.position.beforeFen}|${example.move.uci}|${example.position.afterFen}`;
      const existing = this.examples.findIndex(candidate => `${candidate.position.beforeFen}|${candidate.move.uci}|${candidate.position.afterFen}` === key);
      if (existing >= 0) this.examples.splice(existing, 1);
      this.examples.push(example);
      if (this.examples.length > this.limit) this.examples.splice(0, this.examples.length - this.limit);
      this.persist();
      return example;
    }

    count() { return this.examples.length; }
    jsonl() { return this.examples.map(example => JSON.stringify(example)).join('\n') + (this.examples.length ? '\n' : ''); }

    download() {
      if (!this.examples.length) return false;
      const blob = new Blob([this.jsonl()], { type: 'application/x-ndjson;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `tournament-room-coach-training-${new Date().toISOString().slice(0, 10)}.jsonl`;
      anchor.click();
      URL.revokeObjectURL(url);
      return true;
    }
  }

  window.TournamentCoachTraining = { CoachTrainingRecorder, buildExample, SCHEMA, KEY };
})();
