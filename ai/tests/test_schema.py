import unittest

from chess_coach.schema import SCHEMA, validate_example


START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"


def sample():
    line = {"rank": 1, "scoreType": "cp", "score": 30, "wdl": [350, 450, 200], "pv": "e2e4"}
    return {
        "schema": SCHEMA,
        "position": {"beforeFen": START_FEN, "afterFen": AFTER_E4},
        "move": {"uci": "e2e4", "san": "e4", "mover": "w"},
        "engine": {"before": {"lines": [line]}, "after": {"lines": [line]}},
        "features": {"before": {}, "after": {}},
        "target": {"verdict": "Best", "primaryConcept": "center", "loss": 0.0},
    }


class SchemaTests(unittest.TestCase):
    def test_valid_example_is_accepted(self):
        example = validate_example(sample())
        self.assertEqual(example.played_uci, "e2e4")
        self.assertEqual(example.primary_concept, "center")

    def test_unknown_concept_is_rejected(self):
        raw = sample()
        raw["target"]["primaryConcept"] = "vibes"
        with self.assertRaisesRegex(ValueError, "Unknown primary concept"):
            validate_example(raw)

    def test_analysis_requires_a_principal_variation(self):
        raw = sample()
        raw["engine"]["before"]["lines"] = []
        with self.assertRaisesRegex(ValueError, "principal variation"):
            validate_example(raw)


if __name__ == "__main__":
    unittest.main()
