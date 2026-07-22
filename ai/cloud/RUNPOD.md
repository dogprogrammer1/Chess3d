# Runpod training environment

The first cloud target is one NVIDIA A40 48 GB Pod. The extra memory is not
needed for the tiny smoke model, but leaves room for the `base` grounding model,
larger batches, and a later 1B-3B language-model adapter without changing the
deployment shape.

## Pod settings

- GPU: `NVIDIA A40` (one GPU); use an RTX A6000 48 GB if no A40 is available.
- Image: `runpod/pytorch:1.0.3-cu1281-torch291-ubuntu2404`.
- Container disk: 30 GB (the current official PyTorch template minimum).
- Persistent Pod volume: 20 GB, mounted at `/workspace` for this first corpus.
- Expose `22/tcp` only if using SSH/SCP. No web port is required for training.
- Set an external reminder or provider-side stop schedule before training. Do
  not rely on `runpodctl pod stop` inside the container: older template images
  may ship a CLI without Pod-management commands.

Do not put Runpod API keys, SSH private keys, or dataset credentials in this
repository. The first iteration can be operated entirely from the Runpod web
terminal.

## Put the project and data on the Pod

If these changes are available in the Git remote:

```bash
cd /workspace
git clone https://github.com/dogprogrammer1/Chess3d.git chess3d
mkdir -p /workspace/datasets /workspace/artifacts
```

For unpushed work, transfer this repository and the exported JSONL with SCP,
rsync, or `runpodctl`, then place them at:

```text
/workspace/chess3d
/workspace/datasets/coach-training.jsonl
```

The local bundle helper packages the unpushed AI/JavaScript/tooling sources and
the sampled PGN, while excluding the original compressed archive and caches:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\prepare-runpod-bundle.ps1
```

Upload `datasets\runpod\chess-coach-runpod-bundle.tar.gz`, then extract it into
`/workspace/chess3d`. The labeling launcher automatically finds the bundled PGN.

## Verify CUDA and train

```bash
cd /workspace/chess3d
export PYTHONPATH=/workspace/chess3d/ai
python -m pip install "numpy>=2,<3"
python ai/scripts/smoke_gpu.py --preset tiny
bash ai/cloud/train-runpod.sh
```

## Label the public corpus in parallel

Batch labeling launches Stockfish directly, so it works on Linux without the
browser's Windows-only bridge. Three workers with two Stockfish threads each
fit the A40 Pod's nine-vCPU shape while leaving capacity for Node and the OS.
Each worker owns its output and cache; interrupted runs resume automatically.

Place the sampled PGN at `/workspace/datasets/lichess-sample.pgn`, then run:

```bash
cd /workspace/chess3d
bash ai/cloud/label-runpod.sh
```

The default labeling timeout is three hours. Override it, or cap a first run,
with environment variables:

```bash
COACH_LABEL_TIMEOUT_SECONDS=14400 COACH_LABEL_MAX_EXAMPLES=10000 \
  bash ai/cloud/label-runpod.sh
```

To label, validate, and immediately begin GPU training:

```bash
bash ai/cloud/label-and-train-runpod.sh
```

Training has a separate two-hour default timeout and retains the last completed
epoch checkpoint. These timeouts limit runaway work but do not stop Pod billing;
terminate the Pod from the Runpod console after copying the merged JSONL and
artifacts.

The launcher defaults to a `base` encoder, 20 epochs, a physical batch size of
16, four-step gradient accumulation (effective batch size 64), and early
stopping after four non-improving validation epochs. Override a setting without
editing the script:

```bash
COACH_EPOCHS=5 COACH_PRESET=small COACH_BATCH_SIZE=32 bash ai/cloud/train-runpod.sh
```

Set `COACH_EARLY_STOPPING_PATIENCE=0` to disable early stopping, or tune
`COACH_EARLY_STOPPING_MIN_DELTA` when small validation changes should not reset
patience.

The best model and a resumable `chess-coach-grounding.last.pt` checkpoint are
written to `/workspace/artifacts`. Starting the launcher again resumes the last
checkpoint automatically. Copy the artifacts off the Pod before deleting its
persistent storage. Stopping compute does not stop storage billing; terminate
the Pod and remove unneeded storage after the artifacts are safely copied.

## Export full-precision ONNX

After training, install the export dependencies and convert the best checkpoint
without quantization, pruning, or reduced model dimensions:

```bash
cd /workspace/chess3d
export PYTHONPATH=/workspace/chess3d/ai
python -m pip install -r ai/requirements-export.txt
python ai/scripts/export_onnx.py \
  /workspace/artifacts/chess-coach-grounding.pt \
  --output /workspace/artifacts/chess-coach-grounding.onnx \
  --device cuda
```

The command validates the graph with ONNX, runs it with ONNX Runtime, compares
all nine outputs against PyTorch, and writes
`chess-coach-grounding.onnx.metadata.json` with hashes and numerical error.
