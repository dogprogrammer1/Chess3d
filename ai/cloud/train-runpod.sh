#!/usr/bin/env bash
set -euo pipefail

repo_dir="${COACH_REPO_DIR:-/workspace/chess3d}"
data_dir="${COACH_DATA_DIR:-/workspace/datasets}"
artifact_dir="${COACH_ARTIFACT_DIR:-/workspace/artifacts}"
preset="${COACH_PRESET:-base}"
batch_size="${COACH_BATCH_SIZE:-16}"
accumulation="${COACH_GRADIENT_ACCUMULATION:-4}"
epochs="${COACH_EPOCHS:-20}"
workers="${COACH_WORKERS:-4}"
timeout_seconds="${COACH_TRAIN_TIMEOUT_SECONDS:-7200}"
early_stopping_patience="${COACH_EARLY_STOPPING_PATIENCE:-4}"
early_stopping_min_delta="${COACH_EARLY_STOPPING_MIN_DELTA:-0.0}"

cd "$repo_dir"
export PYTHONPATH="$repo_dir/ai"
mkdir -p "$artifact_dir"

mapfile -t data_files < <(find "$data_dir" -maxdepth 1 -type f -name '*.jsonl' -print | sort)
if (( ${#data_files[@]} == 0 )); then
  echo "No JSONL datasets found in $data_dir" >&2
  exit 2
fi

python ai/scripts/smoke_gpu.py --preset tiny

checkpoint="$artifact_dir/chess-coach-grounding.last.pt"
resume_args=()
if [[ -f "$checkpoint" ]]; then
  resume_args=(--resume "$checkpoint")
fi

timeout --signal=TERM --kill-after=30s "$timeout_seconds" python -m chess_coach.train "${data_files[@]}" \
  --output "$artifact_dir/chess-coach-grounding.pt" \
  --preset "$preset" \
  --epochs "$epochs" \
  --batch-size "$batch_size" \
  --gradient-accumulation "$accumulation" \
  --num-workers "$workers" \
  --early-stopping-patience "$early_stopping_patience" \
  --early-stopping-min-delta "$early_stopping_min_delta" \
  --device cuda \
  --amp \
  --amp-dtype bfloat16 \
  "${resume_args[@]}"
