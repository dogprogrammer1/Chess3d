"""Initial multi-task training entry point for the chess grounding model."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import torch
from torch import nn
from torch.nn import functional as F
from torch.utils.data import DataLoader, Subset

from .data import CoachJsonlDataset
from .model import ChessCoachGroundingModel, ModelConfig


def loss_for_batch(outputs: dict[str, torch.Tensor], batch: dict[str, torch.Tensor]) -> tuple[torch.Tensor, dict[str, float]]:
    move = F.cross_entropy(outputs["move_logits"].flatten(1), batch["move_target"])
    verdict = F.cross_entropy(outputs["verdict_logits"], batch["verdict_target"])
    concepts = F.binary_cross_entropy_with_logits(outputs["concept_logits"], batch["concept_target"])
    value = -(batch["wdl_target"] * outputs["wdl_logits"].log_softmax(dim=-1)).sum(dim=-1).mean()
    connectivity = F.binary_cross_entropy_with_logits(outputs["connectivity_logits"], batch["connectivity_target"])
    total = move + verdict + concepts * 0.5 + value * 0.75 + connectivity * 0.25
    return total, {
        "move": move.item(),
        "verdict": verdict.item(),
        "concept": concepts.item(),
        "wdl": value.item(),
        "connectivity": connectivity.item(),
    }


def move_to_device(batch: dict[str, torch.Tensor], device: torch.device) -> dict[str, torch.Tensor]:
    return {name: value.to(device, non_blocking=True) for name, value in batch.items()}


def resolve_device(requested: str) -> torch.device:
    if requested == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    device = torch.device(requested)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise SystemExit("CUDA was requested, but PyTorch cannot see an NVIDIA GPU")
    return device


def save_checkpoint(path: Path, payload: dict[str, Any]) -> None:
    """Write checkpoints atomically so a pre-empted Pod cannot leave a partial file."""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    torch.save(payload, temporary)
    temporary.replace(path)


def checkpoint_payload(
    model: ChessCoachGroundingModel,
    optimizer: torch.optim.Optimizer,
    scaler: torch.amp.GradScaler,
    config: ModelConfig,
    epoch: int,
    best_validation: float,
    epochs_without_improvement: int,
    args: argparse.Namespace,
) -> dict[str, Any]:
    return {
        "schema": "tournament-room.chess-grounding-checkpoint.v1",
        "config": config.as_dict(),
        "model": model.state_dict(),
        "optimizer": optimizer.state_dict(),
        "scaler": scaler.state_dict(),
        "epoch": epoch,
        "bestValidationLoss": best_validation,
        "epochsWithoutImprovement": epochs_without_improvement,
        "training": {
            "preset": args.preset,
            "batchSize": args.batch_size,
            "gradientAccumulation": args.gradient_accumulation,
            "learningRate": args.learning_rate,
            "seed": args.seed,
            "validationFraction": args.validation_fraction,
            "earlyStoppingPatience": args.early_stopping_patience,
            "earlyStoppingMinDelta": args.early_stopping_min_delta,
        },
    }


def grouped_train_validation_split(
    dataset: CoachJsonlDataset,
    validation_fraction: float,
    seed: int,
) -> tuple[Subset, Subset, int]:
    groups: dict[str, list[int]] = {}
    for index in range(len(dataset)):
        groups.setdefault(dataset.group_id(index), []).append(index)
    if len(groups) < 2:
        raise SystemExit("At least two source games or ungrouped examples are required for a train/validation split")

    group_names = sorted(groups)
    order = torch.randperm(len(group_names), generator=torch.Generator().manual_seed(seed)).tolist()
    validation_group_count = min(len(group_names) - 1, max(1, round(len(group_names) * validation_fraction)))
    selected_groups = {group_names[offset] for offset in order[:validation_group_count]}
    validation_indices = [index for name in selected_groups for index in groups[name]]
    validation_set = set(validation_indices)
    train_indices = [index for index in range(len(dataset)) if index not in validation_set]
    return Subset(dataset, train_indices), Subset(dataset, validation_indices), len(selected_groups)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data", nargs="+", help="Exported coach JSONL files")
    parser.add_argument("--output", default="artifacts/chess-coach-grounding.pt")
    parser.add_argument("--preset", choices=("tiny", "small", "base"), default="tiny")
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--seed", type=int, default=29)
    parser.add_argument("--device", default="auto", help="auto, cpu, cuda, or a CUDA device such as cuda:0")
    parser.add_argument("--amp", action="store_true", help="Use CUDA mixed precision")
    parser.add_argument("--amp-dtype", choices=("bfloat16", "float16"), default="bfloat16")
    parser.add_argument("--gradient-accumulation", type=int, default=1)
    parser.add_argument("--num-workers", type=int, default=0)
    parser.add_argument("--resume", help="Resume a .last.pt training checkpoint")
    parser.add_argument("--validation-fraction", type=float, default=0.1)
    parser.add_argument("--early-stopping-patience", type=int, default=4, help="Stop after this many non-improving epochs; zero disables")
    parser.add_argument("--early-stopping-min-delta", type=float, default=0.0, help="Minimum validation-loss improvement that resets patience")
    args = parser.parse_args()

    if args.epochs < 1 or args.batch_size < 1 or args.gradient_accumulation < 1 or args.num_workers < 0:
        parser.error("epochs, batch size, and gradient accumulation must be positive; workers cannot be negative")
    if args.early_stopping_patience < 0 or args.early_stopping_min_delta < 0:
        parser.error("early stopping patience and minimum delta cannot be negative")
    if not 0 < args.validation_fraction < 0.5:
        parser.error("validation fraction must be greater than zero and less than 0.5")

    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
        torch.set_float32_matmul_precision("high")
    dataset = CoachJsonlDataset(args.data)
    if len(dataset) < 2:
        raise SystemExit("At least two validated coach examples are required")
    train_data, validation_data, validation_groups = grouped_train_validation_split(
        dataset,
        args.validation_fraction,
        args.seed,
    )
    device = resolve_device(args.device)
    loader_options = {
        "batch_size": args.batch_size,
        "num_workers": args.num_workers,
        "pin_memory": device.type == "cuda",
        "persistent_workers": args.num_workers > 0,
    }
    train_loader = DataLoader(train_data, shuffle=True, **loader_options)
    validation_loader = DataLoader(validation_data, **loader_options)

    resume_payload: dict[str, Any] | None = None
    if args.resume:
        resume_payload = torch.load(args.resume, map_location="cpu", weights_only=True)
        if resume_payload.get("schema") != "tournament-room.chess-grounding-checkpoint.v1":
            raise SystemExit(f"Unsupported checkpoint schema in {args.resume}")
        config = ModelConfig(**resume_payload["config"])
    else:
        config = ModelConfig.preset(args.preset)
    model = ChessCoachGroundingModel(config).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=0.02)
    amp_enabled = args.amp and device.type == "cuda"
    amp_dtype = torch.bfloat16 if args.amp_dtype == "bfloat16" else torch.float16
    scaler = torch.amp.GradScaler("cuda", enabled=amp_enabled and amp_dtype == torch.float16)

    start_epoch = 1
    best_validation = float("inf")
    epochs_without_improvement = 0
    if resume_payload is not None:
        model.load_state_dict(resume_payload["model"])
        optimizer.load_state_dict(resume_payload["optimizer"])
        scaler_state = resume_payload.get("scaler")
        if scaler_state:
            scaler.load_state_dict(scaler_state)
        start_epoch = int(resume_payload["epoch"]) + 1
        best_validation = float(resume_payload.get("bestValidationLoss", best_validation))
        epochs_without_improvement = int(resume_payload.get("epochsWithoutImprovement", 0))

    print(json.dumps({
        "device": str(device),
        "gpu": torch.cuda.get_device_name(device) if device.type == "cuda" else None,
        "parameters": model.parameter_count(),
        "examples": len(dataset),
        "trainExamples": len(train_data),
        "validationExamples": len(validation_data),
        "validationGroups": validation_groups,
        "amp": args.amp_dtype if amp_enabled else None,
        "effectiveBatchSize": args.batch_size * args.gradient_accumulation,
        "resumedAtEpoch": start_epoch if resume_payload is not None else None,
        "earlyStoppingPatience": args.early_stopping_patience,
        "earlyStoppingMinDelta": args.early_stopping_min_delta,
    }))

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    last_output = output.with_name(f"{output.stem}.last{output.suffix}")
    for epoch in range(start_epoch, args.epochs + 1):
        model.train()
        train_loss = 0.0
        optimizer.zero_grad(set_to_none=True)
        for step, batch in enumerate(train_loader, 1):
            batch = move_to_device(batch, device)
            with torch.autocast(device_type=device.type, dtype=amp_dtype, enabled=amp_enabled):
                loss, _ = loss_for_batch(model(batch), batch)
                scaled_loss = loss / args.gradient_accumulation
            scaler.scale(scaled_loss).backward()
            should_step = step % args.gradient_accumulation == 0 or step == len(train_loader)
            if should_step:
                scaler.unscale_(optimizer)
                nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                scaler.step(optimizer)
                scaler.update()
                optimizer.zero_grad(set_to_none=True)
            train_loss += loss.item()

        model.eval()
        validation_loss = 0.0
        with torch.no_grad():
            for batch in validation_loader:
                batch = move_to_device(batch, device)
                with torch.autocast(device_type=device.type, dtype=amp_dtype, enabled=amp_enabled):
                    loss, _ = loss_for_batch(model(batch), batch)
                validation_loss += loss.item()
        train_loss /= max(1, len(train_loader))
        validation_loss /= max(1, len(validation_loader))
        print(json.dumps({"epoch": epoch, "trainLoss": train_loss, "validationLoss": validation_loss}))
        previous_best = best_validation
        improved = validation_loss < previous_best
        significant_improvement = validation_loss < previous_best - args.early_stopping_min_delta
        if improved:
            best_validation = validation_loss
            save_checkpoint(output, {
                "schema": "tournament-room.chess-grounding-model.v1",
                "config": config.as_dict(),
                "model": model.state_dict(),
                "validationLoss": validation_loss,
                "epoch": epoch,
            })
        epochs_without_improvement = 0 if significant_improvement else epochs_without_improvement + 1
        save_checkpoint(
            last_output,
            checkpoint_payload(
                model, optimizer, scaler, config, epoch, best_validation,
                epochs_without_improvement, args,
            ),
        )
        if args.early_stopping_patience and epochs_without_improvement >= args.early_stopping_patience:
            print(json.dumps({
                "status": "early_stopped",
                "epoch": epoch,
                "bestValidationLoss": best_validation,
                "epochsWithoutImprovement": epochs_without_improvement,
            }))
            break


if __name__ == "__main__":
    main()
