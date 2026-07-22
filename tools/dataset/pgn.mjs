const RESULT_TOKENS = new Set(['1-0', '0-1', '1/2-1/2', '*']);

function unescapeTag(value) {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function stripMovetextNoise(text) {
  let result = '';
  let braces = 0;
  let variations = 0;
  let lineComment = false;
  for (const character of text.replace(/^%.*$/gm, '')) {
    if (lineComment) {
      if (character === '\n') { lineComment = false; result += ' '; }
      continue;
    }
    if (braces) {
      if (character === '{') braces += 1;
      else if (character === '}') braces -= 1;
      continue;
    }
    if (character === ';') { lineComment = true; continue; }
    if (character === '{') { braces = 1; continue; }
    if (character === '(') { variations += 1; continue; }
    if (character === ')') { variations = Math.max(0, variations - 1); continue; }
    if (!variations) result += character;
  }
  return result;
}

function movetextGames(text) {
  const groups = [];
  let moves = [];
  const flush = result => {
    if (moves.length) groups.push({ moves, result });
    moves = [];
  };
  for (const rawToken of stripMovetextNoise(text).split(/\s+/).filter(Boolean)) {
    let token = rawToken.replace(/\$\d+/g, '');
    while (/^\d+\.(?:\.\.)?/.test(token)) token = token.replace(/^\d+\.(?:\.\.)?/, '');
    if (!token || token === '...' || /^\$\d+$/.test(token)) continue;
    if (RESULT_TOKENS.has(token)) { flush(token); continue; }
    moves.push(token);
  }
  flush('*');
  return groups;
}

export function parsePgn(text) {
  const games = [];
  let tags = {};
  let movetext = [];
  const flush = () => {
    const groups = movetextGames(movetext.join('\n'));
    groups.forEach(group => games.push({
      tags: { ...tags },
      moves: group.moves,
      result: group.result === '*' ? (tags.Result || '*') : group.result,
    }));
    tags = {};
    movetext = [];
  };

  for (const line of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const tag = line.match(/^\s*\[([A-Za-z0-9_]+)\s+"((?:\\.|[^"])*)"\]\s*$/);
    if (tag) {
      if (movetext.some(value => value.trim())) flush();
      tags[tag[1]] = unescapeTag(tag[2]);
    } else {
      movetext.push(line);
    }
  }
  flush();
  return games;
}

export function replayPgnGame(record, ChessGame, startFen) {
  const initialFen = record.tags.SetUp === '1' && record.tags.FEN ? record.tags.FEN : startFen;
  const game = new ChessGame(initialFen);
  const entries = [];
  record.moves.forEach((san, index) => {
    const move = game.moveFromSan(san);
    if (!move) throw new Error(`Illegal or ambiguous SAN ${san} at ply ${index + 1}`);
    game.apply(move);
    entries.push(game.history.at(-1));
  });
  return { game, entries, initialFen };
}

export { RESULT_TOKENS, stripMovetextNoise };
