/* Turns verified engine and board facts into concise coaching language. */
(function () {
  'use strict';

  const Position = window.TournamentCoachPosition;
  const Grader = window.TournamentCoachGrader;

  function sideName(color) { return color === 'w' ? 'White' : 'Black'; }

  function positionReport(features, analysis) {
    const evaluation = Grader.formatEvaluation(Grader.topLine(analysis), features.fen);
    const balance = features.material.w.total - features.material.b.total;
    const headline = balance === 0
      ? 'Material is level; activity, king safety, and pawn structure decide the assessment.'
      : `${balance > 0 ? 'White' : 'Black'} has a material edge of ${Math.abs(balance)} point${Math.abs(balance) === 1 ? '' : 's'}.`;
    return {
      evaluation,
      headline,
      white: features.advantages.w,
      black: features.advantages.b,
      details: {
        material: `White ${features.material.w.total} · Black ${features.material.b.total}`,
        activity: `White ${features.activity.w.activeMoves} active moves · Black ${features.activity.b.activeMoves}`,
        pawns: `White: ${features.pawns.w.isolated.length} isolated, ${features.pawns.w.doubled} doubled · Black: ${features.pawns.b.isolated.length} isolated, ${features.pawns.b.doubled} doubled`,
        kings: `White king pressure ${features.king.w.attackedRing} · Black king pressure ${features.king.b.attackedRing}`,
      },
    };
  }

  function moveReport({ entry, beforeAnalysis, afterAnalysis, beforeFeatures, afterFeatures, chosenVariation, bestVariation }) {
    const mover = entry.move.piece.color;
    const other = mover === 'w' ? 'b' : 'w';
    const result = Grader.grade({
      beforeAnalysis,
      afterAnalysis,
      beforeFen: entry.beforeFen,
      afterFen: entry.fen,
      mover,
      playedUci: entry.uci,
    });
    const reasons = [];
    const materialDelta = (afterFeatures.material[mover].total - afterFeatures.material[other].total) - (beforeFeatures.material[mover].total - beforeFeatures.material[other].total);
    if (materialDelta > 0) reasons.push(`It improves ${sideName(mover)}'s material balance by ${materialDelta} point${materialDelta === 1 ? '' : 's'}.`);
    if (materialDelta < 0) reasons.push(`It worsens ${sideName(mover)}'s material balance by ${Math.abs(materialDelta)} point${Math.abs(materialDelta) === 1 ? '' : 's'}.`);
    const activityDelta = afterFeatures.activity[mover].activeMoves - beforeFeatures.activity[mover].activeMoves;
    if (activityDelta >= 4) reasons.push('The move gives the pieces noticeably more activity.');
    if (activityDelta <= -4) reasons.push('The move restricts the mover’s own piece activity.');
    const kingPressureDelta = afterFeatures.king[mover].attackedRing - beforeFeatures.king[mover].attackedRing;
    if (kingPressureDelta >= 2) reasons.push('It leaves more squares around the king under enemy pressure.');
    if (kingPressureDelta <= -2) reasons.push('It reduces the immediate pressure around the king.');
    const pawnWeaknessDelta = (afterFeatures.pawns[mover].isolated.length + afterFeatures.pawns[mover].doubled) - (beforeFeatures.pawns[mover].isolated.length + beforeFeatures.pawns[mover].doubled);
    if (pawnWeaknessDelta > 0) reasons.push('The resulting pawn structure contains an additional long-term weakness.');
    if (!reasons.length) reasons.push(result.loss <= .03 ? 'The move preserves the important features of the position.' : 'The main drawback is revealed by the opponent’s strongest continuation.');

    const bestSan = bestVariation?.frames?.[1]?.san || result.bestUci;
    if (!result.exactBest && bestSan) reasons.push(`${bestSan} was the stronger alternative in the engine’s principal line.`);
    const projectedFeatures = chosenVariation?.projectedFen ? Position.analyze(chosenVariation.projectedFen) : afterFeatures;
    const projectedBalance = projectedFeatures.material.w.total - projectedFeatures.material.b.total;
    const forecast = projectedBalance === 0
      ? 'The projected line keeps material level, so plans and piece placement remain decisive.'
      : `${projectedBalance > 0 ? 'White' : 'Black'} emerges from the projected line about ${Math.abs(projectedBalance)} material point${Math.abs(projectedBalance) === 1 ? '' : 's'} ahead.`;

    return { ...result, san: entry.san, reasons, chosenVariation, bestVariation, forecast };
  }

  window.TournamentCoachExplanation = { moveReport, positionReport };
})();
