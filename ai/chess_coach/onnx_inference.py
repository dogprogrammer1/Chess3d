"""Full-precision ONNX Runtime inference for the chess grounding model."""

from __future__ import annotations

import json
from pathlib import Path
import threading
from typing import Any, Mapping

import numpy as np
import onnxruntime as ort

from .encoding import encode_fen
from .prediction import prediction_response, request_evidence


def _providers(requested: str) -> list[str]:
    available = ort.get_available_providers()
    wants_cuda = requested == "cuda" or (requested == "auto" and "CUDAExecutionProvider" in available)
    if wants_cuda:
        if "CUDAExecutionProvider" not in available:
            raise ValueError("CUDA was requested, but ONNX Runtime has no CUDA execution provider")
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    if requested not in ("auto", "cpu"):
        raise ValueError("ONNX device must be auto, cpu, or cuda")
    return ["CPUExecutionProvider"]


def _model_inputs(fen: str, evidence: list[float]) -> dict[str, np.ndarray]:
    encoding = encode_fen(fen)
    return {
        "piece_ids": np.asarray(encoding.piece_ids, dtype=np.int64)[None, :],
        "square_features": np.asarray(encoding.square_features, dtype=np.float32)[None, :, :],
        "global_features": np.asarray(encoding.global_features, dtype=np.float32)[None, :],
        "relations": np.asarray(encoding.relations, dtype=np.float32)[None, :, :, :],
        "evidence_features": np.asarray(evidence, dtype=np.float32)[None, :],
    }


class OnnxGroundingPredictor:
    def __init__(self, model_path: str | Path, device: str = "auto"):
        self.path = Path(model_path).expanduser().resolve()
        if not self.path.is_file():
            raise FileNotFoundError(f"ONNX grounding model was not found: {self.path}")
        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(str(self.path), sess_options=options, providers=_providers(device))
        self.output_names = {output.name for output in self.session.get_outputs()}
        required = {"move_logits", "wdl_logits", "verdict_logits", "concept_logits"}
        missing = required - self.output_names
        if missing:
            raise ValueError(f"ONNX model is missing outputs: {', '.join(sorted(missing))}")
        metadata_path = self.path.with_suffix(f"{self.path.suffix}.metadata.json")
        self.export_metadata = json.loads(metadata_path.read_text(encoding="utf-8")) if metadata_path.is_file() else {}
        self.lock = threading.Lock()

    def metadata(self) -> dict[str, Any]:
        return {
            "checkpoint": self.path.name,
            "checkpointSchema": self.export_metadata.get("schema", "tournament-room.chess-grounding-onnx.v1"),
            "device": self.session.get_providers()[0],
            "epoch": self.export_metadata.get("epoch"),
            "validationLoss": self.export_metadata.get("validation_loss", self.export_metadata.get("validationLoss")),
            "parameters": self.export_metadata.get("parameter_count", self.export_metadata.get("parameters")),
            "precision": self.export_metadata.get("precision", "fp32"),
        }

    def predict(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        fen = str(payload.get("fen") or "")
        if not fen:
            raise ValueError("fen is required")
        inputs = _model_inputs(fen, request_evidence(payload))
        requested_outputs = ["move_logits", "wdl_logits", "verdict_logits", "concept_logits"]
        with self.lock:
            values = self.session.run(requested_outputs, inputs)
        outputs = dict(zip(requested_outputs, values))
        return prediction_response(
            payload,
            self.metadata(),
            move_logits=outputs["move_logits"][0].reshape(-1).tolist(),
            verdict_logits=outputs["verdict_logits"][0].tolist(),
            concept_logits=outputs["concept_logits"][0].tolist(),
            wdl_logits=outputs["wdl_logits"][0].tolist(),
        )
