"""Versioned data contract shared by browser exports and model training."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from .encoding import move_indices, parse_fen

SCHEMA = "tournament-room.coach-example.v1"
VERDICTS = ("Brilliant", "Best", "Excellent", "Good", "Inaccuracy", "Mistake", "Blunder")
CONCEPTS = (
    "material",
    "activity",
    "king_safety",
    "pawn_structure",
    "center",
    "space",
    "development",
    "threat",
    "defense",
    "exchange",
    "endgame",
    "calculation",
)


@dataclass(frozen=True)
class CoachTrainingExample:
    raw: Mapping[str, Any]

    @property
    def before_fen(self) -> str:
        return str(self.raw["position"]["beforeFen"])

    @property
    def after_fen(self) -> str:
        return str(self.raw["position"]["afterFen"])

    @property
    def played_uci(self) -> str:
        return str(self.raw["move"]["uci"])

    @property
    def verdict(self) -> str:
        return str(self.raw["target"]["verdict"])

    @property
    def primary_concept(self) -> str:
        return str(self.raw["target"].get("primaryConcept") or "calculation")


def _require_mapping(value: Any, name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return value


def validate_example(raw: Mapping[str, Any]) -> CoachTrainingExample:
    if raw.get("schema") != SCHEMA:
        raise ValueError(f"Unsupported coach example schema: {raw.get('schema')!r}")
    position = _require_mapping(raw.get("position"), "position")
    move = _require_mapping(raw.get("move"), "move")
    target = _require_mapping(raw.get("target"), "target")
    before_fen = str(position.get("beforeFen") or "")
    after_fen = str(position.get("afterFen") or "")
    parse_fen(before_fen)
    parse_fen(after_fen)
    uci = str(move.get("uci") or "")
    move_indices(uci)
    if move.get("mover") not in ("w", "b"):
        raise ValueError("move.mover must be 'w' or 'b'")
    verdict = str(target.get("verdict") or "")
    if verdict not in VERDICTS:
        raise ValueError(f"Unknown move verdict: {verdict!r}")
    concept = str(target.get("primaryConcept") or "calculation")
    if concept not in CONCEPTS:
        raise ValueError(f"Unknown primary concept: {concept!r}")
    before_engine = _require_mapping(raw.get("engine", {}).get("before"), "engine.before")
    after_engine = _require_mapping(raw.get("engine", {}).get("after"), "engine.after")
    for name, analysis in (("engine.before", before_engine), ("engine.after", after_engine)):
        lines = analysis.get("lines")
        if not isinstance(lines, list) or not lines:
            raise ValueError(f"{name}.lines must contain at least one principal variation")
    return CoachTrainingExample(raw)
