"""JSONL dataset adapter for exported Tournament Room coach examples."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

import torch
from torch.utils.data import Dataset

from .encoding import encode_fen, move_indices
from .feature_context import evidence_vector_from_raw, normalized_wdl, top_line
from .schema import CONCEPTS, VERDICTS, CoachTrainingExample, validate_example


def evidence_vector(example: CoachTrainingExample) -> list[float]:
    return evidence_vector_from_raw(example.raw)


def tensorize_example(example: CoachTrainingExample) -> dict[str, torch.Tensor]:
    encoding = encode_fen(example.before_fen)
    source, destination, promotion = move_indices(example.played_uci)
    concept = torch.zeros(len(CONCEPTS), dtype=torch.float32)
    concept[CONCEPTS.index(example.primary_concept)] = 1.0
    after_line = top_line(example.raw["engine"]["after"])
    connectivity = torch.tensor(encoding.relations, dtype=torch.float32)[..., 5:7].amax(dim=-1)
    return {
        "piece_ids": torch.tensor(encoding.piece_ids, dtype=torch.long),
        "square_features": torch.tensor(encoding.square_features, dtype=torch.float32),
        "global_features": torch.tensor(encoding.global_features, dtype=torch.float32),
        "relations": torch.tensor(encoding.relations, dtype=torch.float32),
        "evidence_features": torch.tensor(evidence_vector(example), dtype=torch.float32),
        "move_target": torch.tensor(source * 64 + destination, dtype=torch.long),
        "promotion_target": torch.tensor(promotion, dtype=torch.long),
        "verdict_target": torch.tensor(VERDICTS.index(example.verdict), dtype=torch.long),
        "concept_target": concept,
        "wdl_target": torch.tensor(normalized_wdl(after_line), dtype=torch.float32),
        "connectivity_target": connectivity,
    }


class CoachJsonlDataset(Dataset):
    def __init__(self, paths: Iterable[str | Path]):
        self.examples: list[CoachTrainingExample] = []
        for path in paths:
            with Path(path).open("r", encoding="utf-8") as stream:
                for line_number, line in enumerate(stream, 1):
                    if not line.strip():
                        continue
                    try:
                        self.examples.append(validate_example(json.loads(line)))
                    except Exception as error:
                        raise ValueError(f"{path}:{line_number}: {error}") from error

    def __len__(self) -> int:
        return len(self.examples)

    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        return tensorize_example(self.examples[index])

    def group_id(self, index: int) -> str:
        """Keep every position from one source game in the same data split."""

        source = self.examples[index].raw.get("source") or {}
        game_id = source.get("gameId") if isinstance(source, dict) else None
        return f"game:{game_id}" if game_id else f"ungrouped:{index}"
