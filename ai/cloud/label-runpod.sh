#!/usr/bin/env bash
set -euo pipefail

repo_dir="${COACH_REPO_DIR:-/workspace/chess3d}"
input_pgn="${COACH_INPUT_PGN:-/workspace/datasets/lichess-sample.pgn}"
output_dir="${COACH_LABEL_OUTPUT:-/workspace/datasets/labeled}"
workers="${COACH_LABEL_WORKERS:-3}"
engine_threads="${COACH_ENGINE_THREADS:-2}"
engine_hash="${COACH_ENGINE_HASH_MB:-256}"
depth="${COACH_LABEL_DEPTH:-12}"
multipv="${COACH_LABEL_MULTIPV:-3}"
sample_every="${COACH_SAMPLE_EVERY:-4}"
timeout_seconds="${COACH_LABEL_TIMEOUT_SECONDS:-10800}"

bundled_pgn="$repo_dir/datasets/lichess/lichess_db_standard_rated_2013-01-sample.pgn"
if [[ ! -f "$input_pgn" && -f "$bundled_pgn" ]]; then
  input_pgn="$bundled_pgn"
fi
if [[ ! -f "$input_pgn" ]]; then
  echo "Input PGN was not found: $input_pgn" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1 || (( $(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0) < 18 )); then
  apt-get update
  apt-get install -y nodejs
fi
if ! command -v node >/dev/null 2>&1 || (( $(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0) < 18 )); then
  echo "Node.js 18 or newer is required after package installation." >&2
  exit 2
fi
if ! command -v stockfish >/dev/null 2>&1 && [[ ! -x /usr/games/stockfish ]]; then
  apt-get update
  apt-get install -y stockfish
fi
engine="$(command -v stockfish || true)"
engine="${engine:-/usr/games/stockfish}"

cd "$repo_dir"
mkdir -p "$output_dir"
arguments=(
  tools/dataset/parallel-label-coach-dataset.mjs
  --input "$input_pgn"
  --output-dir "$output_dir"
  --engine "$engine"
  --workers "$workers"
  --engine-threads "$engine_threads"
  --engine-hash "$engine_hash"
  --depth "$depth"
  --multipv "$multipv"
  --sample-every "$sample_every"
)
if [[ -n "${COACH_LABEL_MAX_EXAMPLES:-}" ]]; then
  arguments+=(--max-examples "$COACH_LABEL_MAX_EXAMPLES")
fi

timeout --signal=TERM --kill-after=30s "$timeout_seconds" node "${arguments[@]}"
python ai/scripts/validate_dataset.py "$output_dir/coach-training.jsonl"
