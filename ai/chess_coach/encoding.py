"""Deterministic 64-square and piece-connectivity encoding.

The neural model is not asked to rediscover board geometry from PGN text. This
module converts a FEN into square tokens, global state, attack maps, pin flags,
and relation channels that can be used as learned attention biases.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

FILES = "abcdefgh"
PIECE_IDS = {
    None: 0,
    "P": 1,
    "N": 2,
    "B": 3,
    "R": 4,
    "Q": 5,
    "K": 6,
    "p": 7,
    "n": 8,
    "b": 9,
    "r": 10,
    "q": 11,
    "k": 12,
}

RELATION_NAMES = (
    "same_rank",
    "same_file",
    "same_diagonal",
    "knight_geometry",
    "king_geometry",
    "attacks",
    "defends",
    "slider_line_of_sight",
)

SLIDER_DIRECTIONS = {
    "b": ((-1, -1), (-1, 1), (1, -1), (1, 1)),
    "r": ((-1, 0), (1, 0), (0, -1), (0, 1)),
    "q": ((-1, -1), (-1, 1), (1, -1), (1, 1), (-1, 0), (1, 0), (0, -1), (0, 1)),
}
KNIGHT_STEPS = ((-2, -1), (-2, 1), (-1, -2), (-1, 2), (1, -2), (1, 2), (2, -1), (2, 1))
KING_STEPS = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))


def _coords(square: int) -> tuple[int, int]:
    return divmod(square, 8)


def _square(row: int, column: int) -> int:
    return row * 8 + column


def _inside(row: int, column: int) -> bool:
    return 0 <= row < 8 and 0 <= column < 8


def piece_color(piece: str | None) -> int | None:
    if piece is None:
        return None
    return 0 if piece.isupper() else 1


def square_from_name(name: str) -> int:
    if len(name) != 2 or name[0] not in FILES or name[1] not in "12345678":
        raise ValueError(f"Invalid square name: {name!r}")
    return _square(8 - int(name[1]), FILES.index(name[0]))


def square_name(square: int) -> str:
    row, column = _coords(square)
    return f"{FILES[column]}{8 - row}"


def move_indices(uci: str) -> tuple[int, int, int]:
    if len(uci) not in (4, 5):
        raise ValueError(f"Invalid UCI move: {uci!r}")
    source = square_from_name(uci[:2])
    destination = square_from_name(uci[2:4])
    promotion = 0
    if len(uci) == 5:
        promotions = {"q": 0, "r": 1, "b": 2, "n": 3}
        if uci[4] not in promotions:
            raise ValueError(f"Invalid promotion in UCI move: {uci!r}")
        promotion = promotions[uci[4]]
    return source, destination, promotion


def parse_fen(fen: str) -> tuple[list[str | None], str, str, str, int, int]:
    parts = fen.split()
    if len(parts) != 6:
        raise ValueError("FEN must contain six fields")
    placement, turn, castling, en_passant, halfmove, fullmove = parts
    if turn not in ("w", "b"):
        raise ValueError("FEN side to move must be 'w' or 'b'")
    ranks = placement.split("/")
    if len(ranks) != 8:
        raise ValueError("FEN placement must contain eight ranks")
    board: list[str | None] = []
    for rank in ranks:
        row: list[str | None] = []
        for token in rank:
            if token.isdigit():
                count = int(token)
                if not 1 <= count <= 8:
                    raise ValueError("Invalid FEN empty-square count")
                row.extend([None] * count)
            elif token in "prnbqkPRNBQK":
                row.append(token)
            else:
                raise ValueError(f"Invalid FEN piece token: {token!r}")
        if len(row) != 8:
            raise ValueError("Every FEN rank must describe eight squares")
        board.extend(row)
    if castling != "-" and (any(right not in "KQkq" for right in castling) or len(set(castling)) != len(castling)):
        raise ValueError("Invalid FEN castling rights")
    if en_passant != "-":
        square_from_name(en_passant)
    return board, turn, castling, en_passant, int(halfmove), int(fullmove)


def _step_targets(square: int, steps: Iterable[tuple[int, int]]) -> list[int]:
    row, column = _coords(square)
    return [_square(row + dr, column + dc) for dr, dc in steps if _inside(row + dr, column + dc)]


def attacked_squares(board: Sequence[str | None], source: int) -> list[int]:
    piece = board[source]
    if piece is None:
        return []
    kind = piece.lower()
    color = piece_color(piece)
    row, column = _coords(source)
    if kind == "p":
        direction = -1 if color == 0 else 1
        return [_square(row + direction, column + dc) for dc in (-1, 1) if _inside(row + direction, column + dc)]
    if kind == "n":
        return _step_targets(source, KNIGHT_STEPS)
    if kind == "k":
        return _step_targets(source, KING_STEPS)
    targets: list[int] = []
    for dr, dc in SLIDER_DIRECTIONS[kind]:
        target_row, target_column = row + dr, column + dc
        while _inside(target_row, target_column):
            target = _square(target_row, target_column)
            targets.append(target)
            if board[target] is not None:
                break
            target_row += dr
            target_column += dc
    return targets


def _pinned_squares(board: Sequence[str | None]) -> set[int]:
    pinned: set[int] = set()
    for color, king_token in ((0, "K"), (1, "k")):
        try:
            king_square = board.index(king_token)
        except ValueError:
            continue
        king_row, king_column = _coords(king_square)
        for dr, dc in KING_STEPS:
            candidate: int | None = None
            row, column = king_row + dr, king_column + dc
            while _inside(row, column):
                square = _square(row, column)
                piece = board[square]
                if piece is None:
                    row += dr
                    column += dc
                    continue
                if candidate is None:
                    if piece_color(piece) != color:
                        break
                    candidate = square
                    row += dr
                    column += dc
                    continue
                if piece_color(piece) == color:
                    break
                kind = piece.lower()
                orthogonal = dr == 0 or dc == 0
                if kind == "q" or (orthogonal and kind == "r") or (not orthogonal and kind == "b"):
                    pinned.add(candidate)
                break
    return pinned


def _material_phase(board: Sequence[str | None]) -> float:
    phase_weights = {"n": 1, "b": 1, "r": 2, "q": 4}
    phase = sum(phase_weights.get(piece.lower(), 0) for piece in board if piece)
    return min(1.0, phase / 24.0)


@dataclass(frozen=True)
class BoardEncoding:
    fen: str
    piece_ids: tuple[int, ...]
    square_features: tuple[tuple[float, ...], ...]
    global_features: tuple[float, ...]
    relations: tuple[tuple[tuple[float, ...], ...], ...]
    pinned_squares: tuple[int, ...]

    @property
    def relation_count(self) -> int:
        return len(RELATION_NAMES)


def encode_fen(fen: str) -> BoardEncoding:
    board, turn, castling, en_passant, halfmove, fullmove = parse_fen(fen)
    attack_counts = [[0, 0] for _ in range(64)]
    attacked_by_source: dict[int, set[int]] = {}
    for source, piece in enumerate(board):
        if piece is None:
            continue
        targets = set(attacked_squares(board, source))
        attacked_by_source[source] = targets
        color = piece_color(piece)
        for target in targets:
            attack_counts[target][color] += 1

    pinned = _pinned_squares(board)
    relation_rows: list[tuple[tuple[float, ...], ...]] = []
    for source in range(64):
        source_row, source_column = _coords(source)
        source_piece = board[source]
        source_color = piece_color(source_piece)
        row_relations: list[tuple[float, ...]] = []
        for target in range(64):
            target_row, target_column = _coords(target)
            delta_row = abs(source_row - target_row)
            delta_column = abs(source_column - target_column)
            target_piece = board[target]
            reaches = target in attacked_by_source.get(source, set())
            slider = bool(source_piece and source_piece.lower() in SLIDER_DIRECTIONS and reaches)
            row_relations.append((
                float(source_row == target_row and source != target),
                float(source_column == target_column and source != target),
                float(delta_row == delta_column and source != target),
                float((delta_row, delta_column) in ((1, 2), (2, 1))),
                float(max(delta_row, delta_column) == 1 and source != target),
                float(reaches and (target_piece is None or piece_color(target_piece) != source_color)),
                float(reaches and target_piece is not None and piece_color(target_piece) == source_color),
                float(slider),
            ))
        relation_rows.append(tuple(row_relations))

    square_features = []
    side_to_move = 0 if turn == "w" else 1
    for square, piece in enumerate(board):
        color = piece_color(piece)
        square_features.append((
            min(1.0, attack_counts[square][0] / 8.0),
            min(1.0, attack_counts[square][1] / 8.0),
            float(square in pinned),
            float(piece is not None),
            float(piece is not None and color == side_to_move),
        ))

    en_passant_file = [0.0] * 9
    if en_passant == "-":
        en_passant_file[8] = 1.0
    else:
        en_passant_file[FILES.index(en_passant[0])] = 1.0
    global_features = (
        float(turn == "w"),
        float(turn == "b"),
        float("K" in castling),
        float("Q" in castling),
        float("k" in castling),
        float("q" in castling),
        *en_passant_file,
        min(1.0, max(0, halfmove) / 100.0),
        min(1.0, max(1, fullmove) / 200.0),
        _material_phase(board),
    )
    return BoardEncoding(
        fen=fen,
        piece_ids=tuple(PIECE_IDS[piece] for piece in board),
        square_features=tuple(square_features),
        global_features=tuple(global_features),
        relations=tuple(relation_rows),
        pinned_squares=tuple(sorted(pinned)),
    )
