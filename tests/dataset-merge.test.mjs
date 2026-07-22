import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { mergeCoachDatasets } from '../tools/dataset/merge-coach-datasets.mjs';
import { countLines, parseParallelArguments } from '../tools/dataset/parallel-label-coach-dataset.mjs';

function example(gameId, ply, verdict) {
  return {
    schema: 'tournament-room.coach-example.v1',
    source: { gameId, ply },
    target: { verdict, primaryConcept: 'calculation' },
  };
}

function manifest(index, examplesTotal) {
  return {
    schema: 'tournament-room.coach-dataset-manifest.v1',
    status: 'complete',
    inputs: ['games.pgn'],
    engine: { transport: 'uci', depth: 12, multiPv: 3, threads: 2, hashMb: 256 },
    sampling: { every: 4, minPly: 8, maxPly: 120 },
    shard: { index, count: 2 },
    examplesTotal,
  };
}

test('merge verifies complete shards and reports distributions', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chess3d-merge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const shards = [path.join(directory, 'part-0.jsonl'), path.join(directory, 'part-1.jsonl')];
  const rows = [
    example('00000000aaaaaaaaaaaaaaaa', 8, 'Best'),
    example('00000001bbbbbbbbbbbbbbbb', 12, 'Mistake'),
  ];
  for (let index = 0; index < 2; index += 1) {
    await writeFile(shards[index], `${JSON.stringify(rows[index])}\n`, 'utf8');
    await writeFile(`${shards[index]}.manifest.json`, JSON.stringify(manifest(index, 1)), 'utf8');
  }
  const output = path.join(directory, 'coach-training.jsonl');
  const result = await mergeCoachDatasets({ inputs: shards, output });
  assert.equal(result.counts.examples, 2);
  assert.equal(result.counts.games, 2);
  assert.deepEqual(result.counts.verdicts, { Best: 1, Mistake: 1 });
  assert.equal((await readFile(output, 'utf8')).trim().split('\n').length, 2);
});

test('parallel options reject unsafe or incomplete caps', () => {
  assert.throws(() => parseParallelArguments([
    '--input', 'games.pgn', '--output-dir', 'out', '--engine', 'stockfish', '--workers', '3', '--max-examples', '2',
  ]), /worker count/);
  const options = parseParallelArguments([
    '--input', 'games.pgn', '--output-dir', 'out', '--engine', 'stockfish', '--workers', '3', '--min-ply', '0',
  ]);
  assert.equal(options.workers, 3);
  assert.equal(options.minPly, 0);
});

test('parallel resume counts existing shard examples', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chess3d-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const shard = path.join(directory, 'part.jsonl');
  await writeFile(shard, '{"id":1}\n\n{"id":2}\n', 'utf8');
  assert.equal(await countLines(shard), 2);
  assert.equal(await countLines(path.join(directory, 'missing.jsonl')), 0);
});
