"""Chess-native grounding components for Tournament Room's AI coach."""

from .encoding import BoardEncoding, encode_fen
from .schema import CoachTrainingExample, validate_example

__all__ = ["BoardEncoding", "CoachTrainingExample", "encode_fen", "validate_example"]
