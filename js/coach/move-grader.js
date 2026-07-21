/* Normalizes engine scores and grades a played move from the mover's view. */
(function () {
  'use strict';

  function turnFromFen(fen) { return String(fen).split(' ')[1] === 'b' ? 'b' : 'w'; }
  function topLine(analysis) { return analysis?.lines?.[0] || analysis || null; }

  function expectedForSideToMove(line) {
    if (!line) return .5;
    if (Array.isArray(line.wdl) && line.wdl.length === 3) return (Number(line.wdl[0]) + Number(line.wdl[1]) * .5) / 1000;
    if (line.scoreType === 'mate') return Number(line.score) > 0 ? 1 : 0;
    return 1 / (1 + Math.exp(-Number(line.score || 0) / 220));
  }

  function whiteExpected(line, fen) {
    const value = expectedForSideToMove(line);
    return turnFromFen(fen) === 'w' ? value : 1 - value;
  }

  function whiteCentipawns(line, fen) {
    if (!line) return 0;
    const raw = line.scoreType === 'mate' ? (Number(line.score) > 0 ? 100000 : -100000) : Number(line.score || 0);
    return turnFromFen(fen) === 'w' ? raw : -raw;
  }

  function formatEvaluation(line, fen) {
    if (!line) return '—';
    const score = whiteCentipawns(line, fen);
    if (line.scoreType === 'mate') return `M${score > 0 ? '+' : ''}${Math.sign(score) * Math.abs(Number(line.score))}`;
    return `${score >= 0 ? '+' : ''}${(score / 100).toFixed(2)}`;
  }

  function grade({ beforeAnalysis, afterAnalysis, beforeFen, afterFen, mover, playedUci }) {
    const before = topLine(beforeAnalysis);
    const after = topLine(afterAnalysis);
    const beforeWhite = whiteExpected(before, beforeFen);
    const afterWhite = whiteExpected(after, afterFen);
    const beforeForMover = mover === 'w' ? beforeWhite : 1 - beforeWhite;
    const afterForMover = mover === 'w' ? afterWhite : 1 - afterWhite;
    const loss = Math.max(0, beforeForMover - afterForMover);
    const bestUci = String(before?.pv || '').split(/\s+/)[0] || '';
    const exactBest = Boolean(bestUci && bestUci === playedUci);
    let verdict = exactBest || loss <= .01 ? 'Best' : loss <= .03 ? 'Excellent' : loss <= .07 ? 'Good' : loss <= .14 ? 'Inaccuracy' : loss <= .25 ? 'Mistake' : 'Blunder';

    const beforeCp = mover === 'w' ? whiteCentipawns(before, beforeFen) : -whiteCentipawns(before, beforeFen);
    const afterCp = mover === 'w' ? whiteCentipawns(after, afterFen) : -whiteCentipawns(after, afterFen);
    if (beforeCp > 90000 && afterCp < 90000) verdict = 'Blunder';
    if (afterCp > 90000 && beforeCp <= 90000) verdict = 'Brilliant';

    return {
      verdict,
      loss,
      exactBest,
      bestUci,
      beforeEvaluation: formatEvaluation(before, beforeFen),
      afterEvaluation: formatEvaluation(after, afterFen),
    };
  }

  window.TournamentCoachGrader = { grade, topLine, whiteExpected, whiteCentipawns, formatEvaluation };
})();
