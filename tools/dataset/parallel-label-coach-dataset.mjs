#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { mergeCoachDatasets } from './merge-coach-datasets.mjs';

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const GENERATOR = path.join(DIRECTORY, 'generate-coach-dataset.mjs');

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) throw new Error(`${name} must be from 1 to ${maximum}.`);
  return number;
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} must be zero or greater.`);
  return number;
}

export function parseParallelArguments(argv) {
  const options = {
    inputs: [], outputDirectory: '', engine: '', workers: 3, engineThreads: 2, engineHash: 256,
    depth: 12, multiPv: 3, sampleEvery: 4, minPly: 8, maxPly: 120,
    maxExamples: Number.MAX_SAFE_INTEGER, help: false,
  };
  const valued = new Set([
    '--input', '--output-dir', '--engine', '--workers', '--engine-threads', '--engine-hash',
    '--depth', '--multipv', '--sample-every', '--min-ply', '--max-ply', '--max-examples',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') { options.help = true; continue; }
    if (!valued.has(token)) throw new Error(`Unknown argument: ${token}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${token} requires a value`);
    if (token === '--input') options.inputs.push(path.resolve(value));
    else if (token === '--output-dir') options.outputDirectory = path.resolve(value);
    else if (token === '--engine') options.engine = path.resolve(value);
    else if (token === '--workers') options.workers = positiveInteger(value, token, 16);
    else if (token === '--engine-threads') options.engineThreads = positiveInteger(value, token, 64);
    else if (token === '--engine-hash') options.engineHash = positiveInteger(value, token, 32768);
    else if (token === '--depth') options.depth = positiveInteger(value, token, 30);
    else if (token === '--multipv') options.multiPv = positiveInteger(value, token, 5);
    else if (token === '--sample-every') options.sampleEvery = positiveInteger(value, token);
    else if (token === '--min-ply') options.minPly = nonNegativeInteger(value, token);
    else if (token === '--max-ply') options.maxPly = positiveInteger(value, token);
    else if (token === '--max-examples') options.maxExamples = positiveInteger(value, token);
  }
  if (!options.help && !options.inputs.length) throw new Error('At least one --input is required.');
  if (!options.help && !options.outputDirectory) throw new Error('--output-dir is required.');
  if (!options.help && !options.engine) throw new Error('--engine is required.');
  if (options.maxPly < options.minPly) throw new Error('--max-ply must be at least --min-ply.');
  if (options.maxExamples !== Number.MAX_SAFE_INTEGER && options.maxExamples < options.workers) {
    throw new Error('--max-examples must be at least the worker count.');
  }
  return options;
}

async function exists(filePath) {
  try { await stat(filePath); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function countLines(filePath) {
  if (!await exists(filePath)) return 0;
  let count = 0;
  const lines = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) count += 1;
  return count;
}

function streamWithPrefix(stream, prefix, log) {
  const lines = readline.createInterface({ input: stream });
  lines.on('line', line => {
    const message = `${prefix} ${line}\n`;
    process.stdout.write(message);
    log.write(message);
  });
}

function runWorker(index, options, paths, quota) {
  const output = paths.shards[index];
  const args = [GENERATOR];
  options.inputs.forEach(input => args.push('--input', input));
  args.push(
    '--output', output,
    '--engine', options.engine,
    '--engine-threads', String(options.engineThreads),
    '--engine-hash', String(options.engineHash),
    '--depth', String(options.depth),
    '--multipv', String(options.multiPv),
    '--sample-every', String(options.sampleEvery),
    '--min-ply', String(options.minPly),
    '--max-ply', String(options.maxPly),
    '--shard-count', String(options.workers),
    '--shard-index', String(index),
  );
  if (quota !== Number.MAX_SAFE_INTEGER) args.push('--max-examples', String(quota));
  if (paths.resume[index]) args.push('--resume');
  const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const log = createWriteStream(path.join(paths.logs, `shard-${String(index).padStart(3, '0')}.log`), { flags: 'a' });
  streamWithPrefix(child.stdout, `[shard ${index}]`, log);
  streamWithPrefix(child.stderr, `[shard ${index} error]`, log);
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      log.end();
      if (code === 0) resolve();
      else reject(new Error(`Shard ${index} exited with code ${code}.`));
    });
  });
  return { child, completion };
}

export async function runParallel(options) {
  await mkdir(options.outputDirectory, { recursive: true });
  const shardDirectory = path.join(options.outputDirectory, 'shards');
  const logDirectory = path.join(options.outputDirectory, 'logs');
  await mkdir(shardDirectory, { recursive: true });
  await mkdir(logDirectory, { recursive: true });
  const shards = Array.from({ length: options.workers }, (_, index) =>
    path.join(shardDirectory, `coach-part-${String(index).padStart(3, '0')}.jsonl`));
  const resume = await Promise.all(shards.map(exists));
  const existingCounts = await Promise.all(shards.map(countLines));
  const quotas = Array.from({ length: options.workers }, (_, index) => {
    if (options.maxExamples === Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
    const target = Math.floor(options.maxExamples / options.workers) + (index < options.maxExamples % options.workers ? 1 : 0);
    return Math.max(0, target - existingCounts[index]);
  });
  const workers = [];
  for (let index = 0; index < options.workers; index += 1) {
    if (quotas[index] === 0) continue;
    workers.push(runWorker(index, options, { shards, logs: logDirectory, resume }, quotas[index]));
  }
  const terminateWorkers = () => workers.forEach(worker => { if (!worker.child.killed) worker.child.kill(); });
  process.once('SIGINT', terminateWorkers);
  process.once('SIGTERM', terminateWorkers);
  try {
    await Promise.all(workers.map(worker => worker.completion));
  } catch (error) {
    terminateWorkers();
    throw error;
  } finally {
    process.removeListener('SIGINT', terminateWorkers);
    process.removeListener('SIGTERM', terminateWorkers);
  }
  const output = path.join(options.outputDirectory, 'coach-training.jsonl');
  const merged = await mergeCoachDatasets({ inputs: shards, output, manifest: `${output}.manifest.json` });
  console.log(JSON.stringify(merged, null, 2));
  return merged;
}

async function main() {
  const options = parseParallelArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node parallel-label-coach-dataset.mjs --input games.pgn --output-dir datasets/labeled --engine stockfish [options]');
    return;
  }
  await runParallel(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
