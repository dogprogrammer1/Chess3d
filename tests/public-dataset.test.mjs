import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import {
  decompressedLichessArchive,
  expectedChecksum,
  parseArguments,
  selectSample,
} from '../tools/dataset/fetch-lichess-sample.mjs';

function game(event, whiteElo, blackElo, moves, result = '1-0') {
  return `[Event "${event}"]
[Site "https://lichess.org/${event}"]
[Result "${result}"]
[WhiteElo "${whiteElo}"]
[BlackElo "${blackElo}"]

${moves} ${result}`;
}

const corpus = [
  game('a', 1800, 1850, '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6'),
  game('b', 1500, 2100, '1. d4 d5 2. c4 e6 3. Nc3 Nf6'),
  game('c', 2000, 2050, '1. c4 e5 2. Nc3 Nf6 3. g3 d5'),
  game('d', 2200, 2250, '1. Nf3 d5 2. g3 c5 3. Bg2 Nc6'),
].join('\n\n');

test('published checksum parser selects an exact archive name', () => {
  const digest = 'a'.repeat(64);
  assert.equal(expectedChecksum(`${digest}  lichess_db_standard_rated_2013-01.pgn.zst\n`,
    'lichess_db_standard_rated_2013-01.pgn.zst'), digest);
  assert.throws(() => expectedChecksum(`${digest}  another-file\n`, 'missing-file'), /No SHA-256/);
});

test('public PGN sampling is filtered, bounded, and deterministic', async () => {
  const options = { maxGames: 2, minRating: 1600, minPlies: 6, seed: 42 };
  const chunks = [corpus.slice(0, 91), corpus.slice(91, 257), corpus.slice(257)];
  const first = await selectSample(Readable.from(chunks), options);
  const second = await selectSample(Readable.from([corpus]), options);
  assert.equal(first.scanned, 4);
  assert.equal(first.eligible, 3);
  assert.equal(first.selected, 2);
  assert.equal(first.pgn, second.pgn);
  assert.doesNotMatch(first.pgn, /Event "b"/);
});

test('public dataset paths default outside version control', () => {
  const options = parseArguments(['--month', '2013-01', '--max-games', '25']);
  assert.equal(options.maxGames, 25);
  assert.match(options.archive, /datasets[\\/]lichess[\\/]source/);
  assert.match(options.output, /-sample\.pgn$/);
  assert.throws(() => parseArguments(['--month', '2013-13']), /YYYY-MM/);
});

test('all independently compressed Lichess frames are decoded', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chess3d-lichess-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = path.join(directory, 'two-frames.pgn.zst');
  const split = Math.floor(corpus.length / 2);
  const frames = [corpus.slice(0, split), corpus.slice(split)]
    .map(text => zstdCompressSync(Buffer.from(text, 'utf8')));
  const indexedFrames = frames.map(frame => {
    const index = Buffer.alloc(12);
    index.writeUInt32LE(0x184D2A50, 0);
    index.writeUInt32LE(4, 4);
    index.writeUInt32LE(frame.length, 8);
    return Buffer.concat([index, frame]);
  });
  await writeFile(archive, Buffer.concat(indexedFrames));

  const options = { maxGames: 10, minRating: 0, minPlies: 0, seed: 1 };
  const selected = await selectSample(Readable.from(decompressedLichessArchive(archive)), options);
  assert.equal(selected.scanned, 4);
  assert.equal(selected.selected, 4);
});
