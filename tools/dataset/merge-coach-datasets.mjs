#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, unlink, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

import { shardForGame } from './generate-coach-dataset.mjs';

function parseArguments(argv) {
  const options = { inputs: [], output: '', manifest: '', help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') { options.help = true; continue; }
    if (!['--input', '--output', '--manifest'].includes(token)) throw new Error(`Unknown argument: ${token}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${token} requires a value`);
    if (token === '--input') options.inputs.push(path.resolve(value));
    else if (token === '--output') options.output = path.resolve(value);
    else options.manifest = path.resolve(value);
  }
  if (!options.help && options.inputs.length < 1) throw new Error('At least one --input shard is required.');
  if (!options.help && !options.output) throw new Error('--output is required.');
  options.manifest ||= `${options.output}.manifest.json`;
  return options;
}

async function fileExists(filePath) {
  try { await stat(filePath); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function configuration(manifest) {
  return {
    inputs: [...(manifest.inputs || [])].sort(),
    engine: {
      transport: manifest.engine?.transport || 'websocket',
      depth: manifest.engine?.depth,
      multiPv: manifest.engine?.multiPv,
      threads: manifest.engine?.threads || null,
      hashMb: manifest.engine?.hashMb || null,
    },
    sampling: manifest.sampling,
    shardCount: manifest.shard?.count,
  };
}

function digestConfiguration(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function exampleKey(example) {
  const gameId = example.source?.gameId;
  const ply = example.source?.ply;
  if (!gameId || !Number.isInteger(ply)) throw new Error('Every merged example requires source.gameId and integer source.ply.');
  return `${gameId}|${ply}`;
}

export async function mergeCoachDatasets({ inputs, output, manifest: manifestPath = `${output}.manifest.json` }) {
  const resolvedInputs = inputs.map(value => path.resolve(value)).sort();
  const resolvedOutput = path.resolve(output);
  if (resolvedInputs.includes(resolvedOutput)) throw new Error('Merged output cannot overwrite one of its input shards.');
  const shardManifests = [];
  for (const input of resolvedInputs) {
    const shardManifestPath = `${input}.manifest.json`;
    if (!await fileExists(shardManifestPath)) throw new Error(`Missing shard manifest: ${shardManifestPath}`);
    const shardManifest = JSON.parse(await readFile(shardManifestPath, 'utf8'));
    if (shardManifest.schema !== 'tournament-room.coach-dataset-manifest.v1' || shardManifest.status !== 'complete') {
      throw new Error(`Shard is not a complete coach dataset: ${shardManifestPath}`);
    }
    shardManifests.push({ input, manifest: shardManifest });
  }

  const expectedConfiguration = configuration(shardManifests[0].manifest);
  const fingerprint = digestConfiguration(expectedConfiguration);
  for (const shard of shardManifests) {
    if (digestConfiguration(configuration(shard.manifest)) !== fingerprint) {
      throw new Error(`Shard settings do not match: ${shard.input}`);
    }
  }
  const shardCount = expectedConfiguration.shardCount;
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardManifests.length !== shardCount) {
    throw new Error(`Expected exactly ${shardCount} shard files, received ${shardManifests.length}.`);
  }
  const indexes = shardManifests.map(shard => shard.manifest.shard.index).sort((a, b) => a - b);
  if (indexes.some((value, index) => value !== index)) throw new Error('Shard indexes must be complete and unique.');
  shardManifests.sort((left, right) => left.manifest.shard.index - right.manifest.shard.index);

  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const temporary = `${resolvedOutput}.part-${process.pid}`;
  const outputHandle = await open(temporary, 'w');
  const keys = new Set();
  const gameIds = new Set();
  const verdicts = {};
  const concepts = {};
  let examples = 0;
  try {
    for (const shard of shardManifests) {
      let shardExamples = 0;
      const lines = readline.createInterface({ input: createReadStream(shard.input), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let example;
        try { example = JSON.parse(line); }
        catch (error) { throw new Error(`${shard.input}:${shardExamples + 1}: ${error.message}`); }
        if (example.schema !== 'tournament-room.coach-example.v1') {
          throw new Error(`Unsupported example schema in ${shard.input}.`);
        }
        const key = exampleKey(example);
        if (keys.has(key)) throw new Error(`Duplicate example across shards: ${key}`);
        if (shardForGame(example.source.gameId, shardCount) !== shard.manifest.shard.index) {
          throw new Error(`Game ${example.source.gameId} is in the wrong shard.`);
        }
        keys.add(key);
        gameIds.add(example.source.gameId);
        const verdict = example.target?.verdict || 'Unknown';
        const concept = example.target?.primaryConcept || 'unknown';
        verdicts[verdict] = (verdicts[verdict] || 0) + 1;
        concepts[concept] = (concepts[concept] || 0) + 1;
        await outputHandle.write(`${JSON.stringify(example)}\n`);
        shardExamples += 1;
        examples += 1;
      }
      if (shardExamples !== shard.manifest.examplesTotal) {
        throw new Error(`Shard count mismatch for ${shard.input}: manifest=${shard.manifest.examplesTotal}, file=${shardExamples}`);
      }
    }
  } catch (error) {
    await outputHandle.close();
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await outputHandle.close();
  await copyFile(temporary, resolvedOutput);
  await unlink(temporary);

  const mergedManifest = {
    schema: 'tournament-room.coach-merged-dataset.v1',
    status: 'complete',
    createdAt: new Date().toISOString(),
    output: path.basename(resolvedOutput),
    configuration: expectedConfiguration,
    shards: shardManifests.map(shard => ({
      index: shard.manifest.shard.index,
      file: path.basename(shard.input),
      examples: shard.manifest.examplesTotal,
    })),
    counts: { examples, games: gameIds.size, verdicts, concepts },
    splitPolicy: 'Group by source.gameId; never split positions from one game across train and validation.',
  };
  await writeFile(manifestPath, `${JSON.stringify(mergedManifest, null, 2)}\n`, 'utf8');
  return mergedManifest;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node merge-coach-datasets.mjs --input shard.jsonl [--input ...] --output coach-training.jsonl');
    return;
  }
  console.log(JSON.stringify(await mergeCoachDatasets(options), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}

