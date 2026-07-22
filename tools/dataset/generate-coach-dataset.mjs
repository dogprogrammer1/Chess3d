#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parsePgn, replayPgnGame } from './pgn.mjs';
import { StockfishBridgeClient } from './stockfish-bridge-client.mjs';
import { UciStockfishClient } from './uci-stockfish-client.mjs';

const TOOL_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TOOL_DIRECTORY, '..', '..');

const HELP = `Usage:
  node tools/dataset/generate-coach-dataset.mjs --input games.pgn --output coach-training.jsonl [options]

Inputs may be PGN files or directories. Directories are searched recursively.

Options:
  --bridge URL          Stockfish bridge URL (default ws://127.0.0.1:8765/)
  --engine PATH         Launch a UCI Stockfish executable directly instead
  --engine-threads N    Threads for direct UCI mode (default 1)
  --engine-hash N       Hash memory in MiB for direct UCI mode (default 128)
  --depth N             Stockfish depth, 1-30 (default 12)
  --multipv N           Principal variations, 1-5 (default 3)
  --sample-every N      Sample one of every N plies (default 4)
  --min-ply N           Ignore earlier opening plies (default 8)
  --max-ply N           Ignore later plies (default 120)
  --max-games N         Stop after N parsed games
  --max-examples N      Stop after N newly written examples
  --shard-count N       Deterministic number of game shards (default 1)
  --shard-index N       Zero-based shard selected by this process (default 0)
  --cache PATH          Persistent engine cache JSONL
  --manifest PATH       Build manifest path
  --resume              Append missing examples to an existing output
  --strict              Stop on the first invalid PGN game
  --dry-run             Parse and replay only; do not contact Stockfish
  --help                 Show this help
`;

function positiveInteger(value, name, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

export function parseArguments(argv) {
  const options = {
    inputs: [],
    output: '',
    bridge: 'ws://127.0.0.1:8765/',
    engine: '',
    engineThreads: 1,
    engineHash: 128,
    depth: 12,
    multiPv: 3,
    sampleEvery: 4,
    minPly: 8,
    maxPly: 120,
    maxGames: Number.MAX_SAFE_INTEGER,
    maxExamples: Number.MAX_SAFE_INTEGER,
    shardCount: 1,
    shardIndex: 0,
    cache: '',
    manifest: '',
    resume: false,
    strict: false,
    dryRun: false,
    help: false,
  };
  const values = new Set([
    '--input', '--output', '--bridge', '--engine', '--engine-threads', '--engine-hash',
    '--depth', '--multipv', '--sample-every', '--min-ply', '--max-ply', '--max-games',
    '--max-examples', '--shard-count', '--shard-index', '--cache', '--manifest',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--resume') { options.resume = true; continue; }
    if (token === '--strict') { options.strict = true; continue; }
    if (token === '--dry-run') { options.dryRun = true; continue; }
    if (token === '--help' || token === '-h') { options.help = true; continue; }
    if (!values.has(token)) throw new Error(`Unknown argument: ${token}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${token} requires a value`);
    if (token === '--input') options.inputs.push(value);
    else if (token === '--output') options.output = value;
    else if (token === '--bridge') options.bridge = value;
    else if (token === '--engine') options.engine = value;
    else if (token === '--cache') options.cache = value;
    else if (token === '--manifest') options.manifest = value;
    else if (token === '--depth') options.depth = positiveInteger(value, token, { maximum: 30 });
    else if (token === '--multipv') options.multiPv = positiveInteger(value, token, { maximum: 5 });
    else if (token === '--engine-threads') options.engineThreads = positiveInteger(value, token, { maximum: 128 });
    else if (token === '--engine-hash') options.engineHash = positiveInteger(value, token, { maximum: 65536 });
    else if (token === '--sample-every') options.sampleEvery = positiveInteger(value, token);
    else if (token === '--min-ply') options.minPly = positiveInteger(value, token, { minimum: 0 });
    else if (token === '--max-ply') options.maxPly = positiveInteger(value, token);
    else if (token === '--max-games') options.maxGames = positiveInteger(value, token);
    else if (token === '--max-examples') options.maxExamples = positiveInteger(value, token);
    else if (token === '--shard-count') options.shardCount = positiveInteger(value, token, { maximum: 128 });
    else if (token === '--shard-index') options.shardIndex = positiveInteger(value, token, { minimum: 0, maximum: 127 });
  }
  if (!options.help && !options.inputs.length) throw new Error('At least one --input PGN file or directory is required.');
  if (!options.help && !options.dryRun && !options.output) throw new Error('--output is required unless --dry-run is used.');
  if (options.maxPly < options.minPly) throw new Error('--max-ply must be greater than or equal to --min-ply.');
  if (options.shardIndex >= options.shardCount) throw new Error('--shard-index must be less than --shard-count.');
  if (options.output) {
    options.output = path.resolve(options.output);
    options.cache = path.resolve(options.cache || `${options.output}.engine-cache.jsonl`);
    options.manifest = path.resolve(options.manifest || `${options.output}.manifest.json`);
  }
  options.inputs = options.inputs.map(input => path.resolve(input));
  if (options.engine) options.engine = path.resolve(options.engine);
  return options;
}

async function exists(filePath) {
  try { await stat(filePath); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function collectPgnFiles(inputs) {
  const files = [];
  const visit = async input => {
    const metadata = await stat(input);
    if (metadata.isDirectory()) {
      const children = await readdir(input, { withFileTypes: true });
      for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
        if (child.isDirectory() || (child.isFile() && child.name.toLowerCase().endsWith('.pgn'))) {
          await visit(path.join(input, child.name));
        }
      }
    } else if (metadata.isFile() && input.toLowerCase().endsWith('.pgn')) files.push(input);
    else throw new Error(`Input is not a PGN file or directory: ${input}`);
  };
  for (const input of inputs) await visit(input);
  if (!files.length) throw new Error('No .pgn files were found in the supplied inputs.');
  return files;
}

async function loadCoachRuntime() {
  globalThis.window = globalThis;
  for (const relativePath of [
    'js/domain/chess.js',
    'js/coach/position-analyzer.js',
    'js/coach/move-grader.js',
    'js/coach/variation.js',
    'js/coach/explanation-builder.js',
    'js/coach/training-recorder.js',
  ]) {
    await import(pathToFileURL(path.join(PROJECT_ROOT, relativePath)).href);
  }
  return {
    ChessGame: globalThis.ChessDomain.ChessGame,
    START_FEN: globalThis.ChessDomain.START_FEN,
    Position: globalThis.TournamentCoachPosition,
    Variation: globalThis.TournamentCoachVariation,
    Explanation: globalThis.TournamentCoachExplanation,
    buildExample: globalThis.TournamentCoachTraining.buildExample,
  };
}

export function gameIdFor(record) {
  const identity = {
    event: record.tags.Event || '',
    site: record.tags.Site || '',
    date: record.tags.Date || record.tags.UTCDate || '',
    round: record.tags.Round || '',
    white: record.tags.White || '',
    black: record.tags.Black || '',
    moves: record.moves,
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
}

export function shardForGame(gameId, shardCount) {
  return Number.parseInt(gameId.slice(0, 8), 16) % shardCount;
}

function exampleKey(example) {
  return example.source?.gameId && example.source?.ply
    ? `${example.source.gameId}|${example.source.ply}`
    : `${example.position?.beforeFen}|${example.move?.uci}|${example.position?.afterFen}`;
}

async function readJsonl(filePath) {
  if (!await exists(filePath)) return [];
  const text = await readFile(filePath, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${filePath}:${index + 1}: ${error.message}`); }
  });
}

class CachedAnalyzer {
  constructor(client, filePath, options) {
    this.client = client;
    this.filePath = filePath;
    this.options = options;
    this.values = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  async load() {
    for (const record of await readJsonl(this.filePath)) {
      if (record?.key && record?.analysis) this.values.set(record.key, record.analysis);
    }
  }

  async analyze(fen) {
    const key = `${this.options.depth}|${this.options.multiPv}|${fen}`;
    if (this.values.has(key)) { this.hits += 1; return this.values.get(key); }
    let analysis;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        analysis = await this.client.analyze(fen, {
          depth: this.options.depth,
          multiPv: this.options.multiPv,
        });
        break;
      } catch (error) {
        if (attempt > 0 || typeof this.client.restart !== 'function') throw error;
        console.error(JSON.stringify({ level: 'warning', message: `Restarting Stockfish after: ${error.message}` }));
        await this.client.restart();
      }
    }
    this.values.set(key, analysis);
    this.misses += 1;
    await appendFile(this.filePath, `${JSON.stringify({ key, analysis })}\n`, 'utf8');
    return analysis;
  }
}

function shouldSample(ply, gameId, options) {
  if (ply < options.minPly || ply > options.maxPly) return false;
  const offset = Number.parseInt(gameId.slice(0, 8), 16) % options.sampleEvery;
  return (ply - options.minPly - offset) % options.sampleEvery === 0;
}

function playerRating(tags, mover) {
  const value = Number(mover === 'w' ? tags.WhiteElo : tags.BlackElo);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function buildLabeledExample(runtime, record, entry, gameId, sourceFile, ply, beforeAnalysis, afterAnalysis) {
  const beforeFeatures = runtime.Position.analyze(entry.beforeFen);
  const afterFeatures = runtime.Position.analyze(entry.fen);
  const chosenPv = [entry.uci, ...String(afterAnalysis.lines?.[0]?.pv || '').split(/\s+/).filter(Boolean)].join(' ');
  const chosenVariation = runtime.Variation.build(entry.beforeFen, chosenPv, 9);
  const bestVariation = runtime.Variation.build(entry.beforeFen, beforeAnalysis.lines?.[0]?.pv || '', 9);
  const report = runtime.Explanation.moveReport({
    entry,
    beforeAnalysis,
    afterAnalysis,
    beforeFeatures,
    afterFeatures,
    chosenVariation,
    bestVariation,
  });
  const example = runtime.buildExample({ entry, beforeAnalysis, afterAnalysis, beforeFeatures, afterFeatures, report });
  example.player.rating = playerRating(record.tags, entry.move.piece.color);
  example.source = {
    kind: 'pgn',
    gameId,
    input: path.basename(sourceFile),
    gameIndex: record.index,
    ply,
    result: record.result,
    event: record.tags.Event || '',
    date: record.tags.Date || record.tags.UTCDate || '',
    eco: record.tags.ECO || '',
  };
  return example;
}

async function writeManifest(filePath, manifest) {
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function verifyResumeConfiguration(options, files) {
  if (!await exists(options.manifest)) return;
  const previous = JSON.parse(await readFile(options.manifest, 'utf8'));
  if (previous.schema !== 'tournament-room.coach-dataset-manifest.v1') {
    throw new Error(`Cannot resume an unsupported manifest: ${options.manifest}`);
  }
  const mismatches = [];
  if (previous.engine?.depth !== options.depth) mismatches.push('depth');
  if (previous.engine?.multiPv !== options.multiPv) mismatches.push('multipv');
  if (previous.sampling?.every !== options.sampleEvery) mismatches.push('sample-every');
  if (previous.sampling?.minPly !== options.minPly) mismatches.push('min-ply');
  if (previous.sampling?.maxPly !== options.maxPly) mismatches.push('max-ply');
  if (previous.shard?.count !== options.shardCount) mismatches.push('shard-count');
  if (previous.shard?.index !== options.shardIndex) mismatches.push('shard-index');
  const expectedTransport = options.engine ? 'uci' : 'websocket';
  if ((previous.engine?.transport || 'websocket') !== expectedTransport) mismatches.push('engine-transport');
  if (options.engine && previous.engine?.threads !== options.engineThreads) mismatches.push('engine-threads');
  if (options.engine && previous.engine?.hashMb !== options.engineHash) mismatches.push('engine-hash');
  const previousInputs = [...(previous.inputs || [])].sort();
  const currentInputs = files.map(file => path.basename(file)).sort();
  if (JSON.stringify(previousInputs) !== JSON.stringify(currentInputs)) mismatches.push('inputs');
  if (mismatches.length) {
    throw new Error(`Resume settings differ from the existing manifest (${mismatches.join(', ')}); use a new output path.`);
  }
}

export async function run(options) {
  const files = await collectPgnFiles(options.inputs);
  const runtime = await loadCoachRuntime();
  const counters = {
    files: files.length,
    gamesScanned: 0,
    gamesSeen: 0,
    gamesValid: 0,
    gamesInvalid: 0,
    eligiblePositions: 0,
    examplesExisting: 0,
    examplesWritten: 0,
  };
  const startedAt = new Date().toISOString();

  if (options.dryRun) {
    for (const file of files) {
      const records = parsePgn(await readFile(file, 'utf8'));
      for (const record of records) {
        if (counters.gamesSeen >= options.maxGames) break;
        counters.gamesScanned += 1;
        record.index = counters.gamesScanned;
        const gameId = gameIdFor(record);
        if (shardForGame(gameId, options.shardCount) !== options.shardIndex) continue;
        counters.gamesSeen += 1;
        try {
          const replay = replayPgnGame(record, runtime.ChessGame, runtime.START_FEN);
          counters.gamesValid += 1;
          counters.eligiblePositions += replay.entries.filter((entry, index) => shouldSample(index + 1, gameId, options)).length;
        } catch (error) {
          counters.gamesInvalid += 1;
          if (options.strict) throw error;
          console.error(JSON.stringify({ level: 'warning', file: path.basename(file), game: record.index, message: error.message }));
        }
      }
      if (counters.gamesSeen >= options.maxGames) break;
    }
    const result = { status: 'dry-run', startedAt, finishedAt: new Date().toISOString(), counters };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  await mkdir(path.dirname(options.output), { recursive: true });
  await mkdir(path.dirname(options.cache), { recursive: true });
  await mkdir(path.dirname(options.manifest), { recursive: true });
  const outputExists = await exists(options.output);
  if (outputExists && !options.resume) throw new Error(`Output already exists; pass --resume to continue: ${options.output}`);
  if (outputExists && options.resume) await verifyResumeConfiguration(options, files);
  if (!outputExists) await writeFile(options.output, '', { encoding: 'utf8', flag: 'wx' });
  const existingExamples = await readJsonl(options.output);
  const existingKeys = new Set(existingExamples.map(exampleKey));
  counters.examplesExisting = existingKeys.size;

  const client = options.engine
    ? new UciStockfishClient(options.engine, { threads: options.engineThreads, hashMb: options.engineHash })
    : new StockfishBridgeClient(options.bridge);
  await client.connect();
  const analyzer = new CachedAnalyzer(client, options.cache, options);
  await analyzer.load();
  let stop = false;
  try {
    for (const file of files) {
      const records = parsePgn(await readFile(file, 'utf8'));
      for (const record of records) {
        if (counters.gamesSeen >= options.maxGames || counters.examplesWritten >= options.maxExamples) { stop = true; break; }
        counters.gamesScanned += 1;
        record.index = counters.gamesScanned;
        const gameId = gameIdFor(record);
        if (shardForGame(gameId, options.shardCount) !== options.shardIndex) continue;
        counters.gamesSeen += 1;
        let replay;
        try {
          replay = replayPgnGame(record, runtime.ChessGame, runtime.START_FEN);
          counters.gamesValid += 1;
        } catch (error) {
          counters.gamesInvalid += 1;
          if (options.strict) throw error;
          console.error(JSON.stringify({ level: 'warning', file: path.basename(file), game: record.index, message: error.message }));
          continue;
        }
        for (let index = 0; index < replay.entries.length; index += 1) {
          const ply = index + 1;
          if (!shouldSample(ply, gameId, options)) continue;
          counters.eligiblePositions += 1;
          const entry = replay.entries[index];
          const key = `${gameId}|${ply}`;
          if (existingKeys.has(key)) continue;
          let beforeAnalysis;
          let afterAnalysis;
          try {
            beforeAnalysis = await analyzer.analyze(entry.beforeFen);
            afterAnalysis = await analyzer.analyze(entry.fen);
          } catch (error) {
            if (options.strict) throw error;
            console.error(JSON.stringify({
              level: 'warning', file: path.basename(file), game: record.index, ply,
              message: `Skipping position after engine failure: ${error.message}`,
            }));
            continue;
          }
          if (!beforeAnalysis.lines?.length || !afterAnalysis.lines?.length) {
            console.error(JSON.stringify({
              level: 'warning', file: path.basename(file), game: record.index, ply,
              message: 'Skipping position because Stockfish returned no principal variation.',
            }));
            continue;
          }
          const example = buildLabeledExample(runtime, record, entry, gameId, file, ply, beforeAnalysis, afterAnalysis);
          await appendFile(options.output, `${JSON.stringify(example)}\n`, 'utf8');
          existingKeys.add(key);
          counters.examplesWritten += 1;
          if (counters.examplesWritten % 10 === 0) {
            console.log(JSON.stringify({
              games: counters.gamesSeen,
              examples: counters.examplesWritten,
              cacheHits: analyzer.hits,
              engineSearches: analyzer.misses,
            }));
          }
          if (counters.examplesWritten >= options.maxExamples) { stop = true; break; }
        }
        if (stop) break;
      }
      if (stop) break;
    }
  } finally {
    client.close();
  }

  const manifest = {
    schema: 'tournament-room.coach-dataset-manifest.v1',
    status: 'complete',
    startedAt,
    finishedAt: new Date().toISOString(),
    output: path.basename(options.output),
    inputs: files.map(file => path.basename(file)),
    engine: options.engine
      ? {
          transport: 'uci', executable: path.basename(options.engine), threads: options.engineThreads,
          hashMb: options.engineHash, depth: options.depth, multiPv: options.multiPv,
        }
      : { transport: 'websocket', bridge: options.bridge, depth: options.depth, multiPv: options.multiPv },
    sampling: { every: options.sampleEvery, minPly: options.minPly, maxPly: options.maxPly },
    shard: { index: options.shardIndex, count: options.shardCount },
    counters: { ...counters, cacheHits: analyzer.hits, engineSearches: analyzer.misses },
    examplesTotal: existingKeys.size,
    splitRecommendation: 'Split by source.gameId so positions from one game never cross train and validation sets.',
  };
  await writeManifest(options.manifest, manifest);
  console.log(JSON.stringify(manifest, null, 2));
  return manifest;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) { console.log(HELP); return; }
    await run(options);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
