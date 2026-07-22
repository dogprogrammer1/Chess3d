import unittest

from chess_coach.encoding import RELATION_NAMES, encode_fen, move_indices, square_from_name


START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


class BoardEncodingTests(unittest.TestCase):
    def test_starting_position_has_expected_tokens_and_context(self):
        encoding = encode_fen(START_FEN)
        self.assertEqual(len(encoding.piece_ids), 64)
        self.assertEqual(encoding.piece_ids[square_from_name("a8")], 10)
        self.assertEqual(encoding.piece_ids[square_from_name("e1")], 6)
        self.assertEqual(len(encoding.global_features), 18)
        self.assertEqual(len(encoding.relations), 64)
        self.assertEqual(len(encoding.relations[0][0]), len(RELATION_NAMES))

    def test_attack_and_defense_edges_respect_blockers(self):
        encoding = encode_fen(START_FEN)
        bishop = square_from_name("c1")
        own_pawn = square_from_name("d2")
        beyond_pawn = square_from_name("e3")
        self.assertEqual(encoding.relations[bishop][own_pawn][6], 1.0)
        self.assertEqual(encoding.relations[bishop][own_pawn][7], 1.0)
        self.assertEqual(encoding.relations[bishop][beyond_pawn][5], 0.0)
        self.assertEqual(encoding.relations[bishop][beyond_pawn][7], 0.0)

    def test_absolute_pin_is_encoded(self):
        encoding = encode_fen("4r2k/8/8/8/8/8/4N3/4K3 w - - 0 1")
        self.assertIn(square_from_name("e2"), encoding.pinned_squares)
        self.assertEqual(encoding.square_features[square_from_name("e2")][2], 1.0)

    def test_uci_move_is_mapped_to_source_destination_policy(self):
        source, destination, promotion = move_indices("e7e8q")
        self.assertEqual(source, square_from_name("e7"))
        self.assertEqual(destination, square_from_name("e8"))
        self.assertEqual(promotion, 0)


if __name__ == "__main__":
    unittest.main()
