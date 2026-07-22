"""Pure-Python Stockfish and position context features shared by runtimes."""

from __future__ import annotations

import math
from typing import Any, Mapping


def top_line(analysis: Mapping[str, Any]) -> Mapping[str, Any]:
    lines = analysis.get("lines") or []
    return lines[0] if lines else analysis


def score_feature(line: Mapping[str, Any]) -> float:
    score = float(line.get("score") or 0)
    if line.get("scoreType") == "mate":
        return 1.0 if score > 0 else -1.0
    return math.tanh(score / 600.0)


def normalized_wdl(line: Mapping[str, Any]) -> list[float]:
    values = line.get("wdl") or []
    if len(values) == 3 and sum(float(value) for value in values) > 0:
        total = sum(float(value) for value in values)
        return [float(value) / total for value in values]
    expected = 1.0 / (1.0 + math.exp(-float(line.get("score") or 0) / 220.0))
    return [expected, 0.0, 1.0 - expected]


def _get(mapping: Mapping[str, Any], *path: str, default: float = 0.0) -> float:
    value: Any = mapping
    for key in path:
        if not isinstance(value, Mapping) or key not in value:
            return default
        value = value[key]
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def evidence_vector_from_raw(raw: Mapping[str, Any]) -> list[float]:
    """Build the shared 32-value Stockfish/feature context vector."""

    engine = raw.get("engine") or {}
    before_line = top_line(engine.get("before") or {})
    after_line = top_line(engine.get("after") or {})
    features = raw.get("features") or {}
    before = features.get("before") or {}
    after = features.get("after") or {}
    move = raw.get("move") or {}
    mover = str(move.get("mover") or raw.get("mover") or "w")
    if mover not in ("w", "b"):
        mover = "w"
    opponent = "b" if mover == "w" else "w"
    values = [
        score_feature(before_line),
        score_feature(after_line),
        *normalized_wdl(before_line),
        *normalized_wdl(after_line),
        _get(raw, "target", "loss"),
        _get(after, "material", mover, "total") - _get(before, "material", mover, "total"),
        _get(after, "material", opponent, "total") - _get(before, "material", opponent, "total"),
        _get(after, "activity", mover, "activeMoves") - _get(before, "activity", mover, "activeMoves"),
        _get(after, "activity", opponent, "activeMoves") - _get(before, "activity", opponent, "activeMoves"),
        _get(after, "king", mover, "attackedRing") - _get(before, "king", mover, "attackedRing"),
        _get(after, "king", opponent, "attackedRing") - _get(before, "king", opponent, "attackedRing"),
        _get(after, "pawns", mover, "doubled") - _get(before, "pawns", mover, "doubled"),
        _get(after, "pawns", opponent, "doubled") - _get(before, "pawns", opponent, "doubled"),
        min(1.0, _get(raw, "player", "rating", default=1500.0) / 3000.0),
        float(mover == "w"),
        float(mover == "b"),
    ]
    return (values + [0.0] * 32)[:32]
