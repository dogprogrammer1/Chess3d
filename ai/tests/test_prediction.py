import unittest

from chess_coach.encoding import move_indices
from chess_coach.prediction import legal_policy, prediction_response, request_evidence


START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


class PredictionTests(unittest.TestCase):
    def test_policy_is_normalized_over_legal_moves_only(self):
        logits = [0.0] * 4096
        e2, e4, _ = move_indices("e2e4")
        d2, d4, _ = move_indices("d2d4")
        logits[e2 * 64 + e4] = 3.0
        logits[d2 * 64 + d4] = 1.0
        policy = legal_policy(logits, ["e2e4", "d2d4", "not-a-move"], "d2d4", 5)
        self.assertEqual(policy["legalMoveCount"], 2)
        self.assertEqual(policy["top"][0]["uci"], "e2e4")
        self.assertEqual(policy["played"]["rank"], 2)
        self.assertAlmostEqual(sum(item["probability"] for item in policy["top"]), 1.0)

    def test_response_has_probabilities_and_advisory_schema(self):
        response = prediction_response(
            {"fen": START_FEN, "playedMove": "e2e4", "legalMoves": ["e2e4"], "topK": 3},
            {"checkpoint": "test.onnx"},
            move_logits=[0.0] * 4096,
            verdict_logits=[0.0] * 7,
            concept_logits=[0.0] * 12,
            wdl_logits=[1.0, 0.0, -1.0],
        )
        self.assertEqual(response["schema"], "tournament-room.chess-grounding-prediction.v1")
        self.assertEqual(response["model"]["checkpoint"], "test.onnx")
        self.assertEqual(len(response["concepts"]), 3)
        self.assertAlmostEqual(response["wdl"]["win"] + response["wdl"]["draw"] + response["wdl"]["loss"], 1.0)

    def test_request_evidence_is_runtime_independent(self):
        evidence = request_evidence({"mover": "b", "loss": 0.25, "engine": {}, "features": {}})
        self.assertEqual(len(evidence), 32)
        self.assertEqual(evidence[8], 0.25)
        self.assertEqual(evidence[18:20], [0.0, 1.0])


if __name__ == "__main__":
    unittest.main()
