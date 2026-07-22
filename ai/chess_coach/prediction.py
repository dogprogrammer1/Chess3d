"""Runtime-neutral request parsing and coach prediction formatting."""

from __future__ import annotations

import math
from typing import Any, Mapping, Sequence

from .encoding import move_indices
from .feature_context import evidence_vector_from_raw
from .schema import CONCEPTS, VERDICTS


PREDICTION_SCHEMA = "tournament-room.chess-grounding-prediction.v1"


def request_evidence(payload: Mapping[str, Any]) -> list[float]:
    explicit = payload.get("evidenceFeatures")
    if explicit is not None:
        if not isinstance(explicit, Sequence) or isinstance(explicit, (str, bytes)) or len(explicit) != 32:
            raise ValueError("evidenceFeatures must contain exactly 32 numbers")
        try:
            return [float(value) for value in explicit]
        except (TypeError, ValueError) as error:
            raise ValueError("evidenceFeatures must contain exactly 32 numbers") from error
    raw = {
        "engine": payload.get("engine") or {},
        "features": payload.get("features") or {},
        "move": {"mover": payload.get("mover") or "w"},
        "target": {"loss": payload.get("loss") or 0.0},
        "player": {"rating": payload.get("rating")},
    }
    return evidence_vector_from_raw(raw)


def _softmax(values: Sequence[float]) -> list[float]:
    numeric = [float(value) for value in values]
    maximum = max(numeric)
    exponentials = [math.exp(value - maximum) for value in numeric]
    total = sum(exponentials)
    return [value / total for value in exponentials]


def _sigmoid(values: Sequence[float]) -> list[float]:
    return [1.0 / (1.0 + math.exp(-max(-80.0, min(80.0, float(value))))) for value in values]


def legal_policy(move_logits: Sequence[float], legal_moves: Any, played_move: Any, limit: int) -> dict[str, Any]:
    if not isinstance(legal_moves, list):
        legal_moves = []
    indexed: list[tuple[str, int]] = []
    seen: set[int] = set()
    for value in legal_moves[:256]:
        move = str(value).lower()
        try:
            source, destination, _ = move_indices(move)
        except ValueError:
            continue
        index = source * 64 + destination
        if index in seen:
            continue
        seen.add(index)
        indexed.append((move, index))
    if not indexed:
        return {"top": [], "played": None, "legalMoveCount": 0}
    probabilities = _softmax([move_logits[index] for _, index in indexed])
    ranked = sorted(
        ({"uci": move, "probability": probabilities[offset]} for offset, (move, _) in enumerate(indexed)),
        key=lambda item: item["probability"],
        reverse=True,
    )
    played = None
    if played_move:
        try:
            source, destination, _ = move_indices(str(played_move).lower())
            played_index = source * 64 + destination
            for rank, item in enumerate(ranked, 1):
                candidate_source, candidate_destination, _ = move_indices(item["uci"])
                if candidate_source * 64 + candidate_destination == played_index:
                    played = {**item, "rank": rank}
                    break
        except ValueError:
            pass
    return {"top": ranked[:limit], "played": played, "legalMoveCount": len(indexed)}


def prediction_response(
    payload: Mapping[str, Any],
    metadata: Mapping[str, Any],
    *,
    move_logits: Sequence[float],
    verdict_logits: Sequence[float],
    concept_logits: Sequence[float],
    wdl_logits: Sequence[float],
) -> dict[str, Any]:
    fen = str(payload.get("fen") or "")
    limit = max(1, min(10, int(payload.get("topK") or 5)))
    verdict_probabilities = _softmax(verdict_logits)
    concept_probabilities = _sigmoid(concept_logits)
    wdl_probabilities = _softmax(wdl_logits)
    verdicts = sorted(
        ({"name": name, "probability": verdict_probabilities[index]} for index, name in enumerate(VERDICTS)),
        key=lambda item: item["probability"],
        reverse=True,
    )
    concepts = sorted(
        ({"name": name, "probability": concept_probabilities[index]} for index, name in enumerate(CONCEPTS)),
        key=lambda item: item["probability"],
        reverse=True,
    )
    return {
        "schema": PREDICTION_SCHEMA,
        "fen": fen,
        "model": dict(metadata),
        "wdl": {
            "perspective": "side-to-move",
            "win": wdl_probabilities[0],
            "draw": wdl_probabilities[1],
            "loss": wdl_probabilities[2],
        },
        "verdict": verdicts[0] if payload.get("playedMove") else None,
        "verdicts": verdicts if payload.get("playedMove") else [],
        "concepts": concepts[:limit],
        "policy": legal_policy(move_logits, payload.get("legalMoves"), payload.get("playedMove"), limit),
    }
