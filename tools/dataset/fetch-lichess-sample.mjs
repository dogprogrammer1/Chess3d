#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { createZstdDecompress } from 'node:zlib';

import { parsePgn } from './pgn.mjs';

const TOOL_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TOOL_DIRECTORY, '..', '..');
const STANDARD_BASE_URL = 'https://database.lichess.org/standard';
const LICENSE_URL = 'https://database.lichess.org/';

const HELP = `Usage:
  node tools/dataset/fetch-lichess-sample.mjs [options]

Downloads one official Lichess standard-rated monthly archive, verifies its
published SHA-256 digest, and streams a bounded PGN sample without expanding
the complete archive on disk.

Options:
  --month YYYY-MM       Archive month (default 2013-01, the smallest archive)
  --archive PATH        Compressed archive destination
  --output PATH         Sample PGN destination
  --manifest PATH       Sampling manifest destination
  --max-games N         Games retained by deterministic reservoir (default 2000)
  --min-rating N        Require both players at or above N (default 1600)
  --min-plies N         Ignore very short games (default 12)
  --seed N              Deterministic sampling seed (default 20260721)
  --help                Show this help
`;

function integer(value, name, { minimum = 0 } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  }
  return number;
}

function archiveName(month) {
  return `lichess_db_standard_rated_${month}.pgn.zst`;
}

export function parseArguments(argv) {
  const raw = {
    month: '2013-01',
    archive: '',
    output: '',
    manifest: '',
    maxGames: 2000,
    minRating: 1600,
    minPlies: 12,
    seed: 20260721,
    help: false,
  };
  const valued = new Set([
    '--month', '--archive', '--output', '--manifest', '--max-games',
    '--min-rating', '--min-plies', '--seed',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') { raw.help = true; continue; }
    if (!valued.has(token)) throw new Error(`Unknown argument: ${token}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${token} requires a value`);
    if (token === '--month') raw.month = value;
    else if (token === '--archive') raw.archive = value;
    else if (token === '--output') raw.output = value;
    else if (token === '--manifest') raw.manifest = value;
    else if (token === '--max-games') raw.maxGames = integer(value, token, { minimum: 1 });
    else if (token === '--min-rating') raw.minRating = integer(value, token);
    else if (token === '--min-plies') raw.minPlies = integer(value, token);
    else if (token === '--seed') raw.seed = integer(value, token);
  }
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(raw.month)) {
    throw new Error('--month must use YYYY-MM format.');
  }
  const name = archiveName(raw.month);
  const root = path.join(PROJECT_ROOT, 'datasets', 'lichess');
  raw.archive = path.resolve(raw.archive || path.join(root, 'source', name));
  raw.output = path.resolve(raw.output || path.join(root, `${name.replace('.pgn.zst', '')}-sample.pgn`));
  raw.manifest = path.resolve(raw.manifest || `${raw.output}.manifest.json`);
  raw.sourceUrl = `${STANDARD_BASE_URL}/${name}`;
  raw.checksumUrl = `${STANDARD_BASE_URL}/sha256sums.txt`;
  return raw;
}

async function exists(filePath) {
  try { await stat(filePath); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function expectedChecksum(manifest, filename) {
  for (const line of String(manifest).split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/);
    if (match && match[2] === filename) return match[1].toLowerCase();
  }
  throw new Error(`No SHA-256 checksum was published for ${filename}.`);
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function* decompressedLichessArchive(filePath) {
  const handle = await open(filePath, 'r');
  let offset = 0;
  let frames = 0;
  try {
    const fileSize = (await handle.stat()).size;
    while (offset < fileSize) {
      const header = Buffer.alloc(12);
      const { bytesRead } = await handle.read(header, 0, header.length, offset);
      if (bytesRead !== header.length) throw new Error('Truncated Lichess Zstandard frame header.');
      const magic = header.readUInt32LE(0);
      const metadataSize = header.readUInt32LE(4);
      if (magic < 0x184D2A50 || magic > 0x184D2A5F || metadataSize !== 4) {
        throw new Error(`Unsupported Lichess Zstandard frame index at byte ${offset}.`);
      }
      const compressedSize = header.readUInt32LE(8);
      const frameStart = offset + 12;
      const frameEnd = frameStart + compressedSize - 1;
      if (!compressedSize || frameEnd >= fileSize) throw new Error('Invalid Lichess Zstandard frame length.');
      const decoder = createZstdDecompress();
      for await (const chunk of createReadStream(filePath, { start: frameStart, end: frameEnd }).pipe(decoder)) {
        yield chunk;
      }
      frames += 1;
      offset = frameEnd + 1;
    }
    if (!frames || offset !== fileSize) throw new Error('The complete Lichess archive was not decoded.');
  } finally {
    await handle.close();
  }
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  return response.text();
}

function progressTransform(startByte, totalBytes) {
  let received = startByte;
  let nextReport = Math.floor(startByte / (5 * 1024 * 1024) + 1) * 5 * 1024 * 1024;
  return new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received >= nextReport) {
        const total = totalBytes ? ` / ${(totalBytes / 1048576).toFixed(1)} MiB` : '';
        console.log(`Downloaded ${(received / 1048576).toFixed(1)} MiB${total}`);
        nextReport += 5 * 1024 * 1024;
      }
      callback(null, chunk);
    },
  });
}

async function downloadArchive(options, checksum) {
  await mkdir(path.dirname(options.archive), { recursive: true });
  if (await exists(options.archive)) {
    const actual = await sha256File(options.archive);
    if (actual !== checksum) {
      throw new Error(`Existing archive checksum mismatch: ${options.archive}\nExpected ${checksum}\nActual   ${actual}`);
    }
    console.log(`Using verified archive ${options.archive}`);
    return actual;
  }

  const partial = `${options.archive}.part`;
  const partialSize = await exists(partial) ? (await stat(partial)).size : 0;
  const headers = partialSize ? { Range: `bytes=${partialSize}-` } : {};
  let response = await fetch(options.sourceUrl, { headers, redirect: 'follow' });
  let append = partialSize > 0 && response.status === 206;
  if (response.status === 416 && partialSize) {
    const actual = await sha256File(partial);
    if (actual === checksum) {
      await rename(partial, options.archive);
      return actual;
    }
  }
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${options.sourceUrl}`);
  if (partialSize && !append) console.log('Server did not accept resume; restarting the partial download.');
  const startByte = append ? partialSize : 0;
  const responseLength = Number(response.headers.get('content-length')) || 0;
  const totalBytes = responseLength ? responseLength + startByte : 0;
  console.log(`${append ? 'Resuming' : 'Downloading'} ${options.sourceUrl}`);
  await pipeline(
    Readable.fromWeb(response.body),
    progressTransform(startByte, totalBytes),
    createWriteStream(partial, { flags: append ? 'a' : 'w' }),
  );
  const actual = await sha256File(partial);
  if (actual !== checksum) {
    throw new Error(`Downloaded archive checksum mismatch. The partial file was retained at ${partial}.`);
  }
  await rename(partial, options.archive);
  console.log(`Verified SHA-256 ${actual}`);
  return actual;
}

async function* pgnGames(readable) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  for await (const chunk of readable) {
    buffer += decoder.write(chunk);
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n[Event "', 1);
    while (boundary >= 0) {
      const game = buffer.slice(0, boundary).trim();
      if (game) yield game;
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n[Event "', 1);
    }
  }
  buffer += decoder.end();
  const finalGame = buffer.trim();
  if (finalGame) yield finalGame;
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function eligibleGame(text, options) {
  const records = parsePgn(text);
  if (records.length !== 1) return null;
  const record = records[0];
  const whiteRating = Number(record.tags.WhiteElo);
  const blackRating = Number(record.tags.BlackElo);
  if (!Number.isFinite(whiteRating) || !Number.isFinite(blackRating)) return null;
  if (whiteRating < options.minRating || blackRating < options.minRating) return null;
  if (record.moves.length < options.minPlies) return null;
  if (!new Set(['1-0', '0-1', '1/2-1/2']).has(record.result)) return null;
  if (record.tags.Variant && record.tags.Variant !== 'Standard') return null;
  return record;
}

export async function selectSample(readable, options) {
  const random = randomGenerator(options.seed);
  const reservoir = [];
  let scanned = 0;
  let eligible = 0;
  for await (const text of pgnGames(readable)) {
    scanned += 1;
    if (!eligibleGame(text, options)) continue;
    eligible += 1;
    const candidate = { index: scanned, text };
    if (reservoir.length < options.maxGames) reservoir.push(candidate);
    else {
      const target = Math.floor(random() * eligible);
      if (target < options.maxGames) reservoir[target] = candidate;
    }
  }
  reservoir.sort((left, right) => left.index - right.index);
  return {
    pgn: reservoir.map(game => `${game.text}\n`).join('\n'),
    scanned,
    eligible,
    selected: reservoir.length,
  };
}

export async function run(options) {
  if (typeof createZstdDecompress !== 'function') {
    throw new Error('This importer requires Node.js 24 or a newer runtime with Zstandard support.');
  }
  const checksumManifest = await fetchText(options.checksumUrl);
  const filename = archiveName(options.month);
  const checksum = expectedChecksum(checksumManifest, filename);
  const archiveSha256 = await downloadArchive(options, checksum);

  console.log(`Streaming PGN sample (rating >= ${options.minRating}, plies >= ${options.minPlies})...`);
  // Lichess prepends every independent Zstandard frame with a small skippable
  // index containing that frame's compressed byte length. Decode each range
  // separately because Node's native decoder stops after the first frame.
  const sample = await selectSample(Readable.from(decompressedLichessArchive(options.archive)), options);
  if (!sample.selected) throw new Error('No games matched the requested filters.');

  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, sample.pgn, 'utf8');
  const outputSha256 = createHash('sha256').update(sample.pgn).digest('hex');
  const manifest = {
    schema: 'tournament-room.public-pgn-sample.v1',
    createdAt: new Date().toISOString(),
    license: { name: 'CC0 1.0', url: LICENSE_URL },
    source: { provider: 'Lichess', month: options.month, url: options.sourceUrl, archiveSha256 },
    filters: {
      standardRated: true,
      completedResult: true,
      minRating: options.minRating,
      minPlies: options.minPlies,
      maxGames: options.maxGames,
      seed: options.seed,
    },
    counts: { scanned: sample.scanned, eligible: sample.eligible, selected: sample.selected },
    output: { path: path.basename(options.output), sha256: outputSha256 },
  };
  await mkdir(path.dirname(options.manifest), { recursive: true });
  await writeFile(options.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${sample.selected} of ${sample.eligible} eligible games to ${options.output}`);
  console.log(`Manifest: ${options.manifest}`);
  return manifest;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else await run(options);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
