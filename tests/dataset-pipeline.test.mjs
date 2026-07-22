import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { gameIdFor, parseArguments, run, shardForGame } from '../tools/dataset/generate-coach-dataset.mjs';
import { parseUciInfo } from '../tools/dataset/uci-stockfish-client.mjs';
import { parsePgn, replayPgnGame } from '../tools/dataset/pgn.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = vm.createContext({ window: {}, console });
vm.runInContext(fs.readFileSync(path.join(root, 'js/domain/chess.js'), 'utf8'), context, { filename: 'js/domain/chess.js' });
const { ChessGame, START_FEN } = context.window.ChessDomain;
const fixture = path.join(root, 'tests/fixtures/coach-source-games.pgn');

test('PGN parser removes comments, NAGs, and side variations', () => {
  const games = parsePgn(fs.readFileSync(fixture, 'utf8'));
  assert.equal(games.length, 2);
  assert.deepEqual(games[0].moves, ['e4', 'e5', 'Qh5?!', 'Nc6', 'Bc4', 'Nf6??', 'Qxf7#']);
  assert.equal(games[0].result, '1-0');
  assert.equal(games[1].moves.filter(move => move === 'O-O').length, 2);
});

test('PGN games replay through the shared legal chess domain', () => {
  const games = parsePgn(fs.readFileSync(fixture, 'utf8'));
  const first = replayPgnGame(games[0], ChessGame, START_FEN);
  const second = replayPgnGame(games[1], ChessGame, START_FEN);
  assert.equal(first.entries.length, 7);
  assert.match(first.game.result, /White wins by checkmate/);
  assert.equal(second.entries.length, 16);
  assert.equal(second.entries[8].san, 'O-O');
  assert.equal(second.entries[15].san, 'O-O');
});

test('SAN resolution requires disambiguation and preserves promotion choice', () => {
  const ambiguous = new ChessGame('7k/8/8/8/8/8/3N3N/7K w - - 0 1');
  assert.equal(ambiguous.moveFromSan('Nf3'), null);
  const knight = ambiguous.moveFromSan('Ndf3');
  assert.ok(knight);
  assert.equal(knight.from.c, 3);

  const promotion = new ChessGame('7k/P7/8/8/8/8/8/7K w - - 0 1');
  const move = promotion.moveFromSan('a8=Q+');
  assert.equal(move.promotionChoice, 'q');
  promotion.apply(move);
  assert.equal(promotion.getPieceAt('a8').type, 'q');
});

test('dataset options and game ids are deterministic', () => {
  const options = parseArguments([
    '--input', fixture, '--output', 'out.jsonl', '--depth', '15', '--sample-every', '2',
    '--engine', 'stockfish', '--engine-threads', '2', '--shard-count', '3', '--shard-index', '1',
  ]);
  assert.equal(options.depth, 15);
  assert.equal(options.sampleEvery, 2);
  assert.equal(options.engineThreads, 2);
  assert.equal(options.shardIndex, 1);
  const game = parsePgn(fs.readFileSync(fixture, 'utf8'))[0];
  assert.equal(gameIdFor(game), gameIdFor(structuredClone(game)));
  assert.equal(shardForGame('00000005abcdefabcdefabcd', 3), 2);
});

test('UCI info parsing preserves MultiPV, WDL, score, and line', () => {
  const info = parseUciInfo('info depth 12 multipv 2 score cp -37 nodes 12345 wdl 210 500 290 pv e2e4 e7e5');
  assert.deepEqual(info, {
    rank: 2, scoreType: 'cp', score: -37, pv: 'e2e4 e7e5', nodes: 12345, depth: 12, wdl: [210, 500, 290],
  });
  assert.equal(parseUciInfo('bestmove e2e4'), null);
});

test('dry run validates every source game without contacting Stockfish', async () => {
  const options = parseArguments([
    '--input', fixture,
    '--dry-run',
    '--sample-every', '1',
    '--min-ply', '0',
  ]);
  const result = await run(options);
  assert.equal(result.counters.gamesValid, 2);
  assert.equal(result.counters.gamesInvalid, 0);
  assert.equal(result.counters.eligiblePositions, 23);
});

test('deterministic shards partition games without overlap', async () => {
  const results = [];
  for (let shardIndex = 0; shardIndex < 2; shardIndex += 1) {
    results.push(await run(parseArguments([
      '--input', fixture, '--dry-run', '--sample-every', '1', '--min-ply', '0',
      '--shard-count', '2', '--shard-index', String(shardIndex),
    ])));
  }
  assert.equal(results.reduce((total, result) => total + result.counters.gamesSeen, 0), 2);
  assert.equal(results.reduce((total, result) => total + result.counters.eligiblePositions, 0), 23);
});
