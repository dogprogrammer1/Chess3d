"""Checkpoint-backed, legal-move-filtered inference for the chess coach."""

from __future__ import annotations

from contextlib import nullcontext
from pathlib import Path
import threading
from typing import Any, Mapping, Sequence

import torch

from .encoding import encode_fen
from .model import ChessCoachGroundingModel, ModelConfig
from .prediction import prediction_response, request_evidence


SUPPORTED_CHECKPOINTS = {
    "tournament-room.chess-grounding-model.v1",
    "tournament-room.chess-grounding-checkpoint.v1",
}


def _device(requested: str) -> torch.device:
    if requested == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    result = torch.device(requested)
    if result.type == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA was requested, but PyTorch cannot see an NVIDIA GPU")
    return result


def _model_batch(fen: str, evidence: Sequence[float], device: torch.device) -> dict[str, torch.Tensor]:
    encoding = encode_fen(fen)
    return {
        "piece_ids": torch.tensor(encoding.piece_ids, dtype=torch.long, device=device).unsqueeze(0),
        "square_features": torch.tensor(encoding.square_features, dtype=torch.float32, device=device).unsqueeze(0),
        "global_features": torch.tensor(encoding.global_features, dtype=torch.float32, device=device).unsqueeze(0),
        "relations": torch.tensor(encoding.relations, dtype=torch.float32, device=device).unsqueeze(0),
        "evidence_features": torch.tensor(evidence, dtype=torch.float32, device=device).unsqueeze(0),
    }


class GroundingPredictor:
    def __init__(self, checkpoint_path: str | Path, device: str = "auto"):
        self.path = Path(checkpoint_path).expanduser().resolve()
        if not self.path.is_file():
            raise FileNotFoundError(f"Grounding checkpoint was not found: {self.path}")
        self.device = _device(device)
        payload = torch.load(self.path, map_location="cpu", weights_only=True)
        schema = payload.get("schema")
        if schema not in SUPPORTED_CHECKPOINTS:
            raise ValueError(f"Unsupported grounding checkpoint schema: {schema!r}")
        self.config = ModelConfig(**payload["config"])
        self.model = ChessCoachGroundingModel(self.config)
        self.model.load_state_dict(payload["model"])
        self.model.to(self.device).eval()
        self.checkpoint_schema = str(schema)
        self.epoch = int(payload.get("epoch") or 0)
        self.validation_loss = payload.get("validationLoss", payload.get("bestValidationLoss"))
        self.lock = threading.Lock()

    def metadata(self) -> dict[str, Any]:
        return {
            "checkpoint": self.path.name,
            "checkpointSchema": self.checkpoint_schema,
            "device": str(self.device),
            "epoch": self.epoch,
            "validationLoss": self.validation_loss,
            "parameters": self.model.parameter_count(),
        }

    def predict(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        fen = str(payload.get("fen") or "")
        if not fen:
            raise ValueError("fen is required")
        evidence = request_evidence(payload)
        batch = _model_batch(fen, evidence, self.device)
        autocast = (
            torch.autocast(device_type="cuda", dtype=torch.bfloat16)
            if self.device.type == "cuda"
            else nullcontext()
        )
        with self.lock, torch.inference_mode(), autocast:
            outputs = self.model(batch)
        return prediction_response(
            payload,
            self.metadata(),
            move_logits=outputs["move_logits"][0].float().flatten().cpu().tolist(),
            verdict_logits=outputs["verdict_logits"][0].float().cpu().tolist(),
            concept_logits=outputs["concept_logits"][0].float().cpu().tolist(),
            wdl_logits=outputs["wdl_logits"][0].float().cpu().tolist(),
        )
