import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = vm.createContext({ window: {}, console, AbortController, setTimeout, clearTimeout });

function load(relativePath) {
  vm.runInContext(fs.readFileSync(path.join(root, relativePath), 'utf8'), context, { filename: relativePath });
}

load('js/domain/chess.js');
load('js/coach/position-analyzer.js');
load('js/coach/variation.js');
load('js/coach/move-grader.js');
load('js/coach/explanation-builder.js');
load('js/coach/training-recorder.js');
load('js/coach/grounding-client.js');

class FakeElement {
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this.textContent = ''; this.hidden = false; }
  append(...children) { this.children.push(...children); }
}
context.document = { createElement: tag => new FakeElement(tag) };
context.window.TournamentCoachAnalysis = { AnalysisCoordinator: class {} };
load('js/coach/coach-controller.js');

const { ChessGame, START_FEN } = context.window.ChessDomain;
const Position = context.window.TournamentCoachPosition;
const Variation = context.window.TournamentCoachVariation;
const Grader = context.window.TournamentCoachGrader;
const Training = context.window.TournamentCoachTraining;
const { GroundingCoachClient } = context.window.TournamentGrounding;
const { CoachController } = context.window.TournamentCoach;

function elementText(node) {
  return [node.textContent, ...node.children.flatMap(child => elementText(child))].filter(Boolean).join(' ');
}

test('recorded moves retain UCI and both position boundaries', () => {
  const game = new ChessGame();
  game.apply(game.moveFromUci('e2e4'));
  assert.equal(game.history[0].uci, 'e2e4');
  assert.equal(game.history[0].beforeFen, START_FEN);
  assert.equal(game.history[0].fen, game.fen());
});

test('position analysis identifies material and pawn weaknesses', () => {
  const material = Position.analyze('7k/8/8/8/8/8/8/Q6K w - - 0 1');
  assert.equal(material.material.w.total, 9);
  assert.equal(material.material.b.total, 0);
  const pawns = Position.analyze('7k/8/8/8/8/2P5/2P5/7K w - - 0 1');
  assert.equal(pawns.pawns.w.doubled, 1);
  assert.equal(pawns.pawns.w.isolated.length, 2);
});

test('engine variations are converted into legal SAN frames', () => {
  const variation = Variation.build(START_FEN, 'e2e4 e7e5 g1f3');
  assert.equal(variation.frames.length, 4);
  assert.equal(variation.san, 'e4 e5 Nf3');
});

test('move grading normalizes WDL values from each side to move', () => {
  const after = new ChessGame();
  after.apply(after.moveFromUci('a2a3'));
  const report = Grader.grade({
    beforeAnalysis: { lines: [{ pv: 'e2e4', scoreType: 'cp', score: 35, wdl: [500, 300, 200] }] },
    afterAnalysis: { lines: [{ pv: 'e7e5', scoreType: 'cp', score: 200, wdl: [700, 200, 100] }] },
    beforeFen: START_FEN,
    afterFen: after.fen(),
    mover: 'w',
    playedUci: 'a2a3',
  });
  assert.equal(report.verdict, 'Blunder');
  assert.ok(report.loss > .4);
});

test('coach reports export a versioned model-training example', () => {
  const game = new ChessGame();
  game.apply(game.moveFromUci('e2e4'));
  const entry = game.history[0];
  const line = { rank: 1, scoreType: 'cp', score: 30, wdl: [350, 450, 200], pv: 'e2e4', depth: 8, nodes: 100 };
  const beforeFeatures = Position.analyze(entry.beforeFen);
  const afterFeatures = Position.analyze(entry.fen);
  const variation = Variation.build(entry.beforeFen, 'e2e4 e7e5');
  const report = {
    verdict: 'Best', loss: 0, exactBest: true, bestUci: 'e2e4', beforeEvaluation: '+0.30', afterEvaluation: '+0.30',
    primaryConcept: 'center', evidence: [{ concept: 'center', text: 'Claims the center.', severity: 1, squares: ['e4'] }],
    reasons: ['Claims the center.'], forecast: 'The center remains balanced.', chosenVariation: variation, bestVariation: variation,
  };
  const example = Training.buildExample({
    entry, beforeAnalysis: { fen: entry.beforeFen, depth: 8, lines: [line] }, afterAnalysis: { fen: entry.fen, depth: 8, lines: [line] },
    beforeFeatures, afterFeatures, report,
  });
  assert.equal(example.schema, 'tournament-room.coach-example.v1');
  assert.equal(example.position.beforeFen, START_FEN);
  assert.equal(example.target.primaryConcept, 'center');

  const values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const recorder = new Training.CoachTrainingRecorder(storage, 2);
  recorder.record({ entry, beforeAnalysis: { lines: [line] }, afterAnalysis: { lines: [line] }, beforeFeatures, afterFeatures, report });
  recorder.record({ entry, beforeAnalysis: { lines: [line] }, afterAnalysis: { lines: [line] }, beforeFeatures, afterFeatures, report });
  assert.equal(recorder.count(), 1, 'duplicate position/move examples should be replaced');
  assert.equal(JSON.parse(recorder.jsonl().trim()).move.uci, 'e2e4');
});

test('grounding client sends verified engine context and legal moves', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({
        schema: 'tournament-room.chess-grounding-prediction.v1',
        model: { checkpoint: 'test.pt' },
        concepts: [{ name: 'center', probability: .8 }],
        verdict: { name: 'Best', probability: .7 },
        policy: { top: [], played: null, legalMoveCount: 1 },
      }),
    };
  };
  const client = new GroundingCoachClient({ fetchImpl, timeoutMs: 100 });
  const prediction = await client.predictMove({
    entry: { beforeFen: START_FEN, uci: 'e2e4', move: { piece: { color: 'w' } } },
    beforeAnalysis: { lines: [{ pv: 'e2e4' }] },
    afterAnalysis: { lines: [{ pv: 'e7e5' }] },
    beforeFeatures: { material: {} },
    afterFeatures: { material: {} },
    loss: .01,
    legalMoves: ['e2e4'],
  });
  assert.equal(request.url, 'http://127.0.0.1:8770/v1/predict');
  assert.equal(request.body.playedMove, 'e2e4');
  assert.deepEqual(request.body.legalMoves, ['e2e4']);
  assert.equal(request.body.engine.before.lines[0].pv, 'e2e4');
  assert.equal(prediction.model.checkpoint, 'test.pt');
  assert.equal(client.status, 'online');
});

test('grounding client reports health lifecycle and loaded model metadata', async () => {
  let calls = 0;
  const statuses = [];
  const client = new GroundingCoachClient({
    timeoutMs: 100,
    fetchImpl: async url => {
      calls += 1;
      assert.equal(url, 'http://127.0.0.1:8770/health');
      return {
        ok: true,
        json: async () => ({
          status: 'ok',
          model: { checkpoint: 'coach.onnx', parameters: 23_155_676, precision: 'fp32' },
        }),
      };
    },
  });
  client.onStatus((status, model) => statuses.push({ status, model }));
  const [first, second] = await Promise.all([client.connect(), client.connect()]);
  assert.equal(calls, 1, 'concurrent health checks should share one request');
  assert.equal(first.checkpoint, 'coach.onnx');
  assert.equal(second.parameters, 23_155_676);
  assert.deepEqual(statuses.map(entry => entry.status), ['offline', 'connecting', 'online']);
});

test('grounding client invokes browser fetch without changing its receiver', async () => {
  let receiver = 'not called';
  async function browserLikeFetch() {
    'use strict';
    receiver = this;
    if (this !== undefined) throw new TypeError('Illegal invocation');
    return { ok: true, json: async () => ({ status: 'ok', model: { checkpoint: 'coach.onnx' } }) };
  }

  const client = new GroundingCoachClient({ fetchImpl: browserLikeFetch, timeoutMs: 100 });
  await client.connect();
  assert.equal(receiver, undefined);
  assert.equal(client.status, 'online');
});

test('grounding client marks an incompatible inference response offline', async () => {
  const statuses = [];
  const client = new GroundingCoachClient({
    timeoutMs: 100,
    fetchImpl: async () => ({ ok: true, json: async () => ({ schema: 'unsupported' }) }),
  });
  client.onStatus(status => statuses.push(status));
  await assert.rejects(() => client.predict({ fen: START_FEN }), /unsupported response/);
  assert.equal(client.status, 'offline');
  assert.deepEqual(statuses, ['offline', 'connecting', 'offline']);
});

test('coach renders neural signals as advisory context beside Stockfish truth', () => {
  const controller = Object.create(CoachController.prototype);
  const panel = controller.renderGrounding({
    concepts: [{ name: 'piece_activity', probability: .72 }],
    verdict: { name: 'Best', probability: .61 },
    policy: {
      legalMoveCount: 20,
      played: { uci: 'e2e4', rank: 3, probability: .15 },
      top: [{ uci: 'g1f3', probability: .58 }],
    },
  }, 'Good', START_FEN);
  const text = elementText(panel);
  assert.match(text, /piece activity \(72% confidence\)/);
  assert.match(text, /Stockfish grades the move Good/);
  assert.match(text, /e4 is 3 of 20 legal moves/);
  assert.match(text, /Highest learned move signal: Nf3 \(58%\)/);
  assert.match(text, /Stockfish and verified board facts remain authoritative/);
});

test('every bundled opening continuation is legal', () => {
  const curriculum = JSON.parse(fs.readFileSync(path.join(root, 'data/openings/openings.json'), 'utf8'));
  assert.ok(curriculum.openings.length >= 6);
  for (const opening of curriculum.openings) {
    assert.ok(opening.chapters.length >= 2, `${opening.name} should include multiple chapters`);
    for (const chapter of opening.chapters) {
      const game = new ChessGame();
      for (const uci of chapter.moves) {
        const move = game.moveFromUci(uci);
        assert.ok(move, `${opening.name} / ${chapter.title}: ${uci} should be legal after ${game.pgn()}`);
        game.apply(move);
      }
    }
  }
});
