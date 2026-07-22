#!/usr/bin/env bash
set -euo pipefail

repo_dir="${COACH_REPO_DIR:-/workspace/chess3d}"
output_dir="${COACH_LABEL_OUTPUT:-/workspace/datasets/labeled}"

cd "$repo_dir"
bash ai/cloud/label-runpod.sh
COACH_DATA_DIR="$output_dir" bash ai/cloud/train-runpod.sh
date -u +%FT%TZ > "$output_dir/TRAINING_COMPLETE"

