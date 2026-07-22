"""Validate exported coach JSONL without requiring the training stack."""

from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from chess_coach.encoding import encode_fen  # noqa: E402
from chess_coach.schema import validate_example  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+")
    args = parser.parse_args()
    verdicts: Counter[str] = Counter()
    concepts: Counter[str] = Counter()
    examples = 0
    unique_positions: set[str] = set()
    for filename in args.files:
        path = Path(filename)
        with path.open("r", encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, 1):
                if not line.strip():
                    continue
                try:
                    example = validate_example(json.loads(line))
                    encode_fen(example.before_fen)
                    encode_fen(example.after_fen)
                except Exception as error:
                    raise SystemExit(f"{path}:{line_number}: {error}") from error
                examples += 1
                unique_positions.add(example.before_fen.split(" ", 4)[0])
                verdicts[example.verdict] += 1
                concepts[example.primary_concept] += 1
    print(json.dumps({
        "examples": examples,
        "uniquePositions": len(unique_positions),
        "verdicts": verdicts,
        "concepts": concepts,
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
