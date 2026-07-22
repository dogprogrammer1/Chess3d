"""Exercise the chess grounding model on one GPU forward/backward pass."""

from __future__ import annotations

import argparse
import json

import torch

from chess_coach.encoding import encode_fen
from chess_coach.model import ChessCoachGroundingModel, ModelConfig


START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preset", choices=("tiny", "small", "base"), default="tiny")
    parser.add_argument("--batch-size", type=int, default=2)
    args = parser.parse_args()
    if not torch.cuda.is_available():
        raise SystemExit("GPU smoke test failed: PyTorch cannot see CUDA")

    device = torch.device("cuda")
    encoded = encode_fen(START_FEN)

    def repeat_tensor(value: object, dtype: torch.dtype) -> torch.Tensor:
        tensor = torch.tensor(value, dtype=dtype, device=device)
        return tensor.unsqueeze(0).repeat(args.batch_size, *([1] * tensor.ndim))

    batch = {
        "piece_ids": repeat_tensor(encoded.piece_ids, torch.long),
        "square_features": repeat_tensor(encoded.square_features, torch.float32),
        "global_features": repeat_tensor(encoded.global_features, torch.float32),
        "relations": repeat_tensor(encoded.relations, torch.float32),
        "evidence_features": torch.zeros(args.batch_size, 32, device=device),
    }
    model = ChessCoachGroundingModel(ModelConfig.preset(args.preset)).to(device)
    with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
        outputs = model(batch)
        loss = outputs["move_logits"].square().mean() + outputs["wdl_logits"].square().mean()
    loss.backward()
    result = {
        "status": "ok",
        "torch": torch.__version__,
        "cuda": torch.version.cuda,
        "gpu": torch.cuda.get_device_name(0),
        "preset": args.preset,
        "parameters": model.parameter_count(),
        "peakMemoryMiB": round(torch.cuda.max_memory_allocated() / 1024 ** 2, 1),
        "languagePrefixShape": list(outputs["language_prefix"].shape),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
