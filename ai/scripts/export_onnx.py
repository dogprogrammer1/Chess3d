"""Export and numerically validate the full FP32 chess grounding model."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from torch import nn

from chess_coach.encoding import encode_fen
from chess_coach.model import ChessCoachGroundingModel, ModelConfig


START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
INPUT_NAMES = ("piece_ids", "square_features", "global_features", "relations", "evidence_features")
OUTPUT_NAMES = (
    "move_logits",
    "promotion_logits",
    "wdl_logits",
    "verdict_logits",
    "concept_logits",
    "connectivity_logits",
    "language_prefix",
    "position_embedding",
    "square_embeddings",
)


class OnnxExportWrapper(nn.Module):
    def __init__(self, model: ChessCoachGroundingModel):
        super().__init__()
        self.model = model

    def forward(
        self,
        piece_ids: torch.Tensor,
        square_features: torch.Tensor,
        global_features: torch.Tensor,
        relations: torch.Tensor,
        evidence_features: torch.Tensor,
    ) -> tuple[torch.Tensor, ...]:
        outputs = self.model({
            "piece_ids": piece_ids,
            "square_features": square_features,
            "global_features": global_features,
            "relations": relations,
            "evidence_features": evidence_features,
        })
        return tuple(outputs[name] for name in OUTPUT_NAMES)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def example_inputs(device: torch.device) -> tuple[torch.Tensor, ...]:
    encoded = encode_fen(START_FEN)
    return (
        torch.tensor(encoded.piece_ids, dtype=torch.long, device=device).unsqueeze(0),
        torch.tensor(encoded.square_features, dtype=torch.float32, device=device).unsqueeze(0),
        torch.tensor(encoded.global_features, dtype=torch.float32, device=device).unsqueeze(0),
        torch.tensor(encoded.relations, dtype=torch.float32, device=device).unsqueeze(0),
        torch.zeros(1, 32, dtype=torch.float32, device=device),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint")
    parser.add_argument("--output", default="artifacts/chess-coach-grounding.onnx")
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--tolerance", type=float, default=5e-4)
    args = parser.parse_args()

    checkpoint = Path(args.checkpoint).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    if not checkpoint.is_file():
        parser.error(f"checkpoint was not found: {checkpoint}")
    if args.opset < 17:
        parser.error("opset 17 or newer is required")
    requested_device = "cuda" if args.device == "auto" and torch.cuda.is_available() else "cpu" if args.device == "auto" else args.device
    device = torch.device(requested_device)
    if device.type == "cuda" and not torch.cuda.is_available():
        parser.error("CUDA was requested, but PyTorch cannot see an NVIDIA GPU")

    payload = torch.load(checkpoint, map_location="cpu", weights_only=True)
    config = ModelConfig(**payload["config"])
    model = ChessCoachGroundingModel(config)
    model.load_state_dict(payload["model"])
    wrapper = OnnxExportWrapper(model.to(device).eval())
    inputs = example_inputs(device)
    output.parent.mkdir(parents=True, exist_ok=True)
    dynamic_axes = {name: {0: "batch"} for name in (*INPUT_NAMES, *OUTPUT_NAMES)}
    with torch.inference_mode():
        torch_outputs = wrapper(*inputs)
        torch.onnx.export(
            wrapper,
            inputs,
            str(output),
            input_names=list(INPUT_NAMES),
            output_names=list(OUTPUT_NAMES),
            dynamic_axes=dynamic_axes,
            opset_version=args.opset,
            do_constant_folding=True,
            dynamo=False,
        )

    onnx.checker.check_model(onnx.load(str(output)))
    session = ort.InferenceSession(str(output), providers=["CPUExecutionProvider"])
    numpy_inputs = {name: tensor.detach().cpu().numpy() for name, tensor in zip(INPUT_NAMES, inputs)}
    onnx_outputs = session.run(list(OUTPUT_NAMES), numpy_inputs)
    errors = {
        name: float(np.max(np.abs(expected.detach().cpu().numpy() - actual)))
        for name, expected, actual in zip(OUTPUT_NAMES, torch_outputs, onnx_outputs)
    }
    maximum_error = max(errors.values())
    if maximum_error > args.tolerance:
        raise SystemExit(f"ONNX validation failed: maximum absolute error {maximum_error} exceeds {args.tolerance}")
    metadata = {
        "schema": "tournament-room.chess-grounding-onnx.v1",
        "precision": "float32",
        "quantized": False,
        "opset": args.opset,
        "epoch": int(payload.get("epoch") or 0),
        "validationLoss": payload.get("validationLoss", payload.get("bestValidationLoss")),
        "parameters": model.parameter_count(),
        "sourceCheckpoint": checkpoint.name,
        "sourceCheckpointSha256": sha256(checkpoint),
        "onnxSha256": sha256(output),
        "bytes": output.stat().st_size,
        "outputs": list(OUTPUT_NAMES),
        "maximumAbsoluteError": maximum_error,
        "absoluteErrorByOutput": errors,
    }
    metadata_path = output.with_suffix(f"{output.suffix}.metadata.json")
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "ok", "model": str(output), "metadata": str(metadata_path), **metadata}))


if __name__ == "__main__":
    main()
