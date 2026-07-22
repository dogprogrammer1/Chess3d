import importlib
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


class _Session:
    def get_providers(self):
        return ["CPUExecutionProvider"]


class OnnxMetadataTests(unittest.TestCase):
    def test_export_metadata_uses_current_snake_case_fields(self):
        numpy_stub = types.ModuleType("numpy")
        onnxruntime_stub = types.ModuleType("onnxruntime")
        with patch.dict(sys.modules, {"numpy": numpy_stub, "onnxruntime": onnxruntime_stub}):
            module = importlib.import_module("chess_coach.onnx_inference")

        predictor = module.OnnxGroundingPredictor.__new__(module.OnnxGroundingPredictor)
        predictor.path = Path("chess-coach-grounding.onnx")
        predictor.session = _Session()
        predictor.export_metadata = {
            "schema": "tournament-room.chess-grounding-onnx.v1",
            "epoch": 9,
            "validation_loss": 0.125,
            "parameter_count": 23_155_676,
            "precision": "fp32",
        }

        metadata = predictor.metadata()
        self.assertEqual(metadata["validationLoss"], 0.125)
        self.assertEqual(metadata["parameters"], 23_155_676)
        self.assertEqual(metadata["precision"], "fp32")


if __name__ == "__main__":
    unittest.main()
