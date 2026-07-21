import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = vm.createContext({ window: {}, console });

function load(relativePath) {
  vm.runInContext(fs.readFileSync(path.join(root, relativePath), 'utf8'), context, { filename: relativePath });
}

load('js/domain/chess.js');
load('js/coach/position-analyzer.js');
load('js/coach/variation.js');
load('js/coach/move-grader.js');
load('js/coach/explanation-builder.js');

const { ChessGame, START_FEN } = context.window.ChessDomain;
const Position = context.window.TournamentCoachPosition;
const Variation = context.window.TournamentCoachVariation;
const Grader = context.window.TournamentCoachGrader;

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
