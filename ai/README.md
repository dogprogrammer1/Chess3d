# Tournament Room chess grounding model

This directory contains the first trainable layer of the custom AI coach. It
does not replace Stockfish. It learns a board-aware representation and produces
verifiable move, value, verdict, concept, connectivity, and language-prefix
outputs for a later conversational narrator.

## Architecture

- Every board square is a token with piece, square, attack-count, pin, and
  side-to-move features.
- Eight dynamic relation channels describe board geometry, attacks, defenses,
  and slider line of sight. They become per-head attention biases.
- Multi-task heads predict moves, WDL, coach verdicts, chess concepts, and piece
  connectivity.
- A learned resampler converts the board into 8-16 dense prefix tokens. Those
  tokens are the integration point for a pretrained language model; the LLM is
  not expected to reconstruct the board from FEN text.

The `tiny` preset is for pipeline checks, `small` is the first useful local
experiment, and `base` is the intended 20M-class encoder.

## Dataset contract

The browser exports newline-delimited `tournament-room.coach-example.v1`
records containing:

- FEN before and after the reviewed move.
- UCI/SAN move and mover.
- Stockfish MultiPV/WDL results before and after.
- Deterministic board features.
- Projected and best variations.
- Verified verdict, primary concept, evidence, and coaching text.

Validate an export without PyTorch:

```powershell
python .\ai\scripts\validate_dataset.py .\coach-training.jsonl
```

## Bulk PGN dataset generation

The bulk builder replays standard PGN through the same legal chess domain used
by the app, samples positions deterministically, and labels each move with the
bundled Stockfish bridge. Comments, NAGs, and recursive annotation variations
are ignored; illegal games are reported and skipped unless `-Strict` is used.

First validate a PGN file or directory without starting Stockfish:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\build-coach-dataset.ps1 `
  -InputPath .\games `
  -OutputPath .\datasets\coach-training.jsonl `
  -DryRun
```

Then run a bounded first build:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\build-coach-dataset.ps1 `
  -InputPath .\games `
  -OutputPath .\datasets\coach-training.jsonl `
  -Depth 12 -MultiPv 3 -SampleEvery 4 -MaxGames 25 -MaxExamples 250
```

Pass `-Resume` to continue an interrupted or deliberately bounded build. The
builder writes three files: model-ready JSONL, a persistent engine-analysis
cache, and a manifest containing settings and counts. Cached FENs are not sent
to Stockfish again. Use only PGN corpora whose licenses permit your intended
training and redistribution.

For a larger build, run independent game shards in parallel. Batch workers talk
directly to Stockfish over UCI, use separate caches, resume existing shards, and
merge only when every shard has matching engine and sampling settings:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\build-coach-dataset-parallel.ps1 `
  -InputPath .\datasets\lichess\lichess_db_standard_rated_2013-01-sample.pgn `
  -OutputDirectory .\datasets\labeled -Workers 2 -EngineThreads 2
```

The merged file is `datasets\labeled\coach-training.jsonl`. Shards and engine
caches remain under its `shards` directory for reliable continuation.

### Public seed corpus

Use the official CC0 Lichess standard-rated database when you do not have a
licensed private game corpus. The importer defaults to January 2013 because it
is the smallest complete monthly archive (about 17.8 MB compressed). It verifies
Lichess's published SHA-256 digest, streams decompression, and retains a
deterministic sample without writing the expanded monthly dump to disk. Raw and
sampled data are stored under the Git-ignored `datasets/` directory.

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\get-public-coach-data.ps1 `
  -MaxGames 2000 -MinRating 1600
```

The importer requires Node.js 24 or newer for built-in Zstandard support. Feed
the resulting `datasets\lichess\*-sample.pgn` file to
`tools\build-coach-dataset.ps1`; the model should train on the generated JSONL,
not directly on raw human moves. The JSONL replaces human judgment with fresh
Stockfish MultiPV labels and omits player names from model provenance.

## Training

Create a dedicated Python environment and install the training dependency:

```powershell
python -m venv .\ai\.venv
.\ai\.venv\Scripts\python -m pip install -r .\ai\requirements-train.txt
```

Run a small pipeline training job:

```powershell
$env:PYTHONPATH = ".\ai"
.\ai\.venv\Scripts\python -m chess_coach.train .\coach-training.jsonl --preset tiny --epochs 5
```

The best checkpoint is written under `ai/artifacts/`, which is intentionally
ignored by Git. The trainer keeps every `source.gameId` wholly in either train
or validation data, preventing adjacent positions from the same PGN game from
leaking across the split. Entire opening branches and tactical themes should
also be reserved for out-of-distribution evaluation.

Training stops after four validation epochs without improvement by default. Use
`--early-stopping-patience 0` to disable this, or
`--early-stopping-min-delta` to require a larger improvement before resetting
patience. Both the best inference checkpoint and the resumable `.last.pt`
checkpoint are still written atomically.

## Local inference

Export the complete FP32 model on a machine with PyTorch, ONNX, and ONNX Runtime:

```powershell
$env:PYTHONPATH = ".\ai"
python -m pip install -r .\ai\requirements-export.txt
python .\ai\scripts\export_onnx.py `
  .\ai\artifacts\chess-coach-grounding.pt `
  --output .\ai\artifacts\chess-coach-grounding.onnx
```

The exporter retains every grounding and language-prefix output, performs no
quantization or pruning, checks the ONNX graph, and compares every output
against PyTorch before writing a checksum-bearing metadata file.

For normal use, install the smaller ONNX-only runtime dependencies, place the
`.onnx` model and `.onnx.metadata.json` file under the Git-ignored artifacts
directory, and start the loopback-only service:

```powershell
python -m venv .\ai\.venv
.\ai\.venv\Scripts\python -m pip install -r .\ai\requirements-inference.txt
$env:PYTHONPATH = ".\ai"
.\ai\.venv\Scripts\python -m chess_coach.server `
  --model .\ai\artifacts\chess-coach-grounding.onnx --device cpu
```

`tools/start-tournament-room.ps1` prefers and starts this model automatically
when it exists, while retaining `.pt` compatibility. The browser supplies the current legal move list, Stockfish
lines, and deterministic features. The service returns learned WDL, concepts,
and move verdicts; its policy is filtered to legal moves before it reaches the
UI. A missing or unhealthy service never disables the verified Stockfish coach.

## Current boundary

This stage serves the trained grounding heads to the app and creates
language-prefix embeddings, but it does not yet load a base LLM or generate
free-form explanations. The next stage will attach a licensed instruction model
with cross-attention or LoRA adapters after the grounding heads pass legality,
connectivity, and concept evaluation gates.
