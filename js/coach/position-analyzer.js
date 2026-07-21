/* Deterministic chess features used to ground coach explanations. */
(function () {
  'use strict';

  const { ChessGame, FILES, squareName } = window.ChessDomain;
  const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const LABELS = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
  const SIDES = ['w', 'b'];

  function pieces(game) {
    const result = [];
    for (let r = 0; r < 8; r += 1) for (let c = 0; c < 8; c += 1) {
      const piece = game.getPiece(r, c);
      if (piece) result.push({ ...piece, r, c, square: squareName(r, c) });
    }
    return result;
  }

  function countIslands(files) {
    const occupied = [...files].sort((a, b) => a - b);
    return occupied.reduce((count, file, index) => count + (index === 0 || file > occupied[index - 1] + 1 ? 1 : 0), 0);
  }

  function pawnFeatures(allPieces, color) {
    const pawns = allPieces.filter(piece => piece.color === color && piece.type === 'p');
    const enemies = allPieces.filter(piece => piece.color !== color && piece.type === 'p');
    const byFile = new Map();
    pawns.forEach(pawn => {
      if (!byFile.has(pawn.c)) byFile.set(pawn.c, []);
      byFile.get(pawn.c).push(pawn);
    });
    const files = new Set(byFile.keys());
    const doubled = [...byFile.values()].reduce((sum, group) => sum + Math.max(0, group.length - 1), 0);
    const isolated = pawns.filter(pawn => !files.has(pawn.c - 1) && !files.has(pawn.c + 1));
    const connected = pawns.filter(pawn => pawns.some(other => other !== pawn && Math.abs(other.c - pawn.c) === 1 && Math.abs(other.r - pawn.r) <= 1));
    const passed = pawns.filter(pawn => !enemies.some(enemy => Math.abs(enemy.c - pawn.c) <= 1 && (color === 'w' ? enemy.r < pawn.r : enemy.r > pawn.r)));
    return {
      count: pawns.length,
      doubled,
      isolated: isolated.map(pawn => pawn.square),
      connected: connected.map(pawn => pawn.square),
      passed: passed.map(pawn => pawn.square),
      islands: countIslands(files),
    };
  }

  function kingFeatures(game, allPieces, color) {
    const king = allPieces.find(piece => piece.color === color && piece.type === 'k');
    if (!king) return { square: '', castled: false, shield: 0, attackedRing: 0, inCheck: false };
    const home = color === 'w' ? 7 : 0;
    const direction = color === 'w' ? -1 : 1;
    const castled = king.r === home && (king.c === 2 || king.c === 6);
    let shield = 0;
    let attackedRing = 0;
    for (let dr = -1; dr <= 1; dr += 1) for (let dc = -1; dc <= 1; dc += 1) {
      if (!dr && !dc) continue;
      const r = king.r + dr; const c = king.c + dc;
      if (r < 0 || r > 7 || c < 0 || c > 7) continue;
      if (game.isSquareAttacked(r, c, color === 'w' ? 'b' : 'w')) attackedRing += 1;
    }
    for (const dc of [-1, 0, 1]) {
      const pawn = game.getPiece(king.r + direction, king.c + dc);
      if (pawn?.color === color && pawn.type === 'p') shield += 1;
    }
    return { square: king.square, castled, shield, attackedRing, inCheck: game.isInCheck(color) };
  }

  function materialFeatures(allPieces, color) {
    const counts = { p: 0, n: 0, b: 0, r: 0, q: 0 };
    allPieces.filter(piece => piece.color === color && piece.type !== 'k').forEach(piece => { counts[piece.type] += 1; });
    const total = Object.entries(counts).reduce((sum, [type, count]) => sum + VALUES[type] * count, 0);
    return { counts, total };
  }

  function activityFeatures(game, allPieces, color) {
    const moves = game.allLegalMoves(color);
    const activeMoves = moves.filter(move => move.piece.type !== 'p' && move.piece.type !== 'k').length;
    const captures = moves.filter(move => move.capture || move.enPassant).length;
    const home = color === 'w' ? 7 : 0;
    const undeveloped = allPieces.filter(piece => piece.color === color && ['n', 'b'].includes(piece.type) && piece.r === home && [1, 2, 5, 6].includes(piece.c)).length;
    const centerPieces = allPieces.filter(piece => piece.color === color && piece.r >= 2 && piece.r <= 5 && piece.c >= 2 && piece.c <= 5).length;
    return { mobility: moves.length, activeMoves, captures, undeveloped, centerPieces };
  }

  function buildAdvantages(result, color) {
    const other = color === 'w' ? 'b' : 'w';
    const advantages = [];
    const materialLead = result.material[color].total - result.material[other].total;
    if (materialLead > 0) advantages.push(`has ${materialLead} more material point${materialLead === 1 ? '' : 's'}`);
    if (result.activity[color].activeMoves >= result.activity[other].activeMoves + 4) advantages.push('has more active pieces and useful moves');
    if (result.activity[color].centerPieces > result.activity[other].centerPieces) advantages.push('occupies more central space');
    if (result.pawns[color].passed.length) advantages.push(`has ${result.pawns[color].passed.length} passed pawn${result.pawns[color].passed.length === 1 ? '' : 's'}`);
    if (result.king[color].castled && !result.king[other].castled) advantages.push('has completed king safety by castling');
    if (result.king[color].attackedRing + 2 <= result.king[other].attackedRing) advantages.push('has the safer king');
    if (!advantages.length) advantages.push('has no single dominant structural advantage');
    return advantages;
  }

  function analyze(fen) {
    const game = new ChessGame(fen);
    const allPieces = pieces(game);
    const result = {
      fen,
      turn: game.turn,
      material: {},
      activity: {},
      pawns: {},
      king: {},
      advantages: {},
    };
    SIDES.forEach(color => {
      result.material[color] = materialFeatures(allPieces, color);
      result.activity[color] = activityFeatures(game, allPieces, color);
      result.pawns[color] = pawnFeatures(allPieces, color);
      result.king[color] = kingFeatures(game, allPieces, color);
    });
    SIDES.forEach(color => { result.advantages[color] = buildAdvantages(result, color); });
    return result;
  }

  function describeMaterial(material) {
    return Object.entries(material.counts).filter(([, count]) => count).map(([type, count]) => `${count} ${LABELS[type]}${count === 1 ? '' : 's'}`).join(', ');
  }

  window.TournamentCoachPosition = { analyze, describeMaterial, VALUES, FILES };
})();
