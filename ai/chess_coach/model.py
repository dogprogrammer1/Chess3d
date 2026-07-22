"""Relation-aware chess encoder and model-facing grounding heads.

This is deliberately not a standalone chess engine or prose generator. It
learns a spatial board representation, move/value/concept heads, and a compact
set of prefix tokens that a pretrained language model can consume later.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import math

import torch
from torch import Tensor, nn

from .encoding import RELATION_NAMES
from .schema import CONCEPTS, VERDICTS


@dataclass(frozen=True)
class ModelConfig:
    d_model: int = 192
    layers: int = 6
    heads: int = 6
    ff_multiplier: int = 4
    dropout: float = 0.1
    square_feature_count: int = 5
    global_feature_count: int = 18
    evidence_feature_count: int = 32
    relation_count: int = len(RELATION_NAMES)
    language_dimension: int = 768
    language_prefix_tokens: int = 12

    def as_dict(self) -> dict[str, int | float]:
        return asdict(self)

    @classmethod
    def preset(cls, name: str) -> "ModelConfig":
        presets = {
            "tiny": cls(d_model=96, layers=3, heads=4, language_dimension=384, language_prefix_tokens=8),
            "small": cls(),
            "base": cls(d_model=384, layers=10, heads=12, language_dimension=1024, language_prefix_tokens=16),
        }
        if name not in presets:
            raise ValueError(f"Unknown model preset {name!r}; choose from {', '.join(presets)}")
        return presets[name]


class RelationAwareAttention(nn.Module):
    def __init__(self, config: ModelConfig):
        super().__init__()
        if config.d_model % config.heads:
            raise ValueError("d_model must be divisible by heads")
        self.heads = config.heads
        self.head_dimension = config.d_model // config.heads
        self.scale = self.head_dimension ** -0.5
        self.qkv = nn.Linear(config.d_model, config.d_model * 3)
        self.output = nn.Linear(config.d_model, config.d_model)
        self.dropout = nn.Dropout(config.dropout)
        self.relation_bias = nn.Parameter(torch.zeros(config.heads, config.relation_count))

    def forward(self, tokens: Tensor, relations: Tensor) -> Tensor:
        batch, token_count, width = tokens.shape
        qkv = self.qkv(tokens).reshape(batch, token_count, 3, self.heads, self.head_dimension)
        query, key, value = qkv.unbind(dim=2)
        query = query.transpose(1, 2)
        key = key.transpose(1, 2)
        value = value.transpose(1, 2)
        scores = torch.einsum("bhid,bhjd->bhij", query, key) * self.scale
        scores = scores + torch.einsum("bijr,hr->bhij", relations, self.relation_bias)
        weights = self.dropout(scores.softmax(dim=-1))
        attended = torch.einsum("bhij,bhjd->bhid", weights, value)
        attended = attended.transpose(1, 2).reshape(batch, token_count, width)
        return self.output(attended)


class EncoderBlock(nn.Module):
    def __init__(self, config: ModelConfig):
        super().__init__()
        hidden = config.d_model * config.ff_multiplier
        self.attention_norm = nn.LayerNorm(config.d_model)
        self.attention = RelationAwareAttention(config)
        self.feed_forward_norm = nn.LayerNorm(config.d_model)
        self.feed_forward = nn.Sequential(
            nn.Linear(config.d_model, hidden),
            nn.GELU(),
            nn.Dropout(config.dropout),
            nn.Linear(hidden, config.d_model),
            nn.Dropout(config.dropout),
        )

    def forward(self, tokens: Tensor, relations: Tensor) -> Tensor:
        tokens = tokens + self.attention(self.attention_norm(tokens), relations)
        return tokens + self.feed_forward(self.feed_forward_norm(tokens))


class ChessBoardEncoder(nn.Module):
    def __init__(self, config: ModelConfig):
        super().__init__()
        self.config = config
        self.piece_embedding = nn.Embedding(13, config.d_model)
        self.square_embedding = nn.Embedding(64, config.d_model)
        self.square_feature_projection = nn.Linear(config.square_feature_count, config.d_model)
        self.context_projection = nn.Sequential(
            nn.Linear(config.global_feature_count + config.evidence_feature_count, config.d_model),
            nn.GELU(),
            nn.Linear(config.d_model, config.d_model),
        )
        self.cls = nn.Parameter(torch.empty(1, 1, config.d_model))
        self.blocks = nn.ModuleList(EncoderBlock(config) for _ in range(config.layers))
        self.final_norm = nn.LayerNorm(config.d_model)
        nn.init.normal_(self.cls, std=0.02)

    def forward(
        self,
        piece_ids: Tensor,
        square_features: Tensor,
        global_features: Tensor,
        relations: Tensor,
        evidence_features: Tensor | None = None,
    ) -> tuple[Tensor, Tensor]:
        batch = piece_ids.shape[0]
        if evidence_features is None:
            evidence_features = global_features.new_zeros(batch, self.config.evidence_feature_count)
        square_ids = torch.arange(64, device=piece_ids.device).expand(batch, -1)
        context = self.context_projection(torch.cat((global_features, evidence_features), dim=-1))
        squares = (
            self.piece_embedding(piece_ids)
            + self.square_embedding(square_ids)
            + self.square_feature_projection(square_features)
            + context.unsqueeze(1)
        )
        tokens = torch.cat((self.cls.expand(batch, -1, -1) + context.unsqueeze(1), squares), dim=1)
        expanded_relations = relations.new_zeros(batch, 65, 65, relations.shape[-1])
        expanded_relations[:, 1:, 1:] = relations
        for block in self.blocks:
            tokens = block(tokens, expanded_relations)
        tokens = self.final_norm(tokens)
        return tokens[:, 0], tokens[:, 1:]


class ChessCoachGroundingModel(nn.Module):
    """Spatial encoder plus verifiable policy, value, concept, and prefix heads."""

    def __init__(self, config: ModelConfig):
        super().__init__()
        self.config = config
        self.encoder = ChessBoardEncoder(config)
        self.source_projection = nn.Linear(config.d_model, config.d_model, bias=False)
        self.destination_projection = nn.Linear(config.d_model, config.d_model, bias=False)
        self.source_bias = nn.Linear(config.d_model, 1)
        self.destination_bias = nn.Linear(config.d_model, 1)
        self.promotion_head = nn.Linear(config.d_model, 4)
        self.wdl_head = nn.Linear(config.d_model, 3)
        self.verdict_head = nn.Linear(config.d_model, len(VERDICTS))
        self.concept_head = nn.Linear(config.d_model, len(CONCEPTS))
        self.connectivity_source = nn.Linear(config.d_model, config.d_model, bias=False)
        self.connectivity_destination = nn.Linear(config.d_model, config.d_model, bias=False)
        self.language_projection = nn.Linear(config.d_model, config.language_dimension)
        self.language_queries = nn.Parameter(
            torch.empty(1, config.language_prefix_tokens, config.language_dimension)
        )
        language_heads = max(1, math.gcd(config.heads, config.language_dimension))
        self.language_resampler = nn.MultiheadAttention(
            config.language_dimension,
            language_heads,
            dropout=config.dropout,
            batch_first=True,
        )
        nn.init.normal_(self.language_queries, std=0.02)

    def forward(self, batch: dict[str, Tensor]) -> dict[str, Tensor]:
        pooled, squares = self.encoder(
            batch["piece_ids"],
            batch["square_features"],
            batch["global_features"],
            batch["relations"],
            batch.get("evidence_features"),
        )
        source = self.source_projection(squares)
        destination = self.destination_projection(squares)
        move_logits = torch.einsum("bid,bjd->bij", source, destination) / math.sqrt(self.config.d_model)
        move_logits = move_logits + self.source_bias(squares) + self.destination_bias(squares).transpose(1, 2)
        connectivity = torch.einsum(
            "bid,bjd->bij", self.connectivity_source(squares), self.connectivity_destination(squares)
        ) / math.sqrt(self.config.d_model)
        board_tokens = self.language_projection(torch.cat((pooled.unsqueeze(1), squares), dim=1))
        queries = self.language_queries.expand(squares.shape[0], -1, -1)
        language_prefix, _ = self.language_resampler(queries, board_tokens, board_tokens, need_weights=False)
        return {
            "move_logits": move_logits,
            "promotion_logits": self.promotion_head(squares),
            "wdl_logits": self.wdl_head(pooled),
            "verdict_logits": self.verdict_head(pooled),
            "concept_logits": self.concept_head(pooled),
            "connectivity_logits": connectivity,
            "language_prefix": language_prefix,
            "position_embedding": pooled,
            "square_embeddings": squares,
        }

    def parameter_count(self) -> int:
        return sum(parameter.numel() for parameter in self.parameters())
