import assert from 'node:assert/strict';
import test from 'node:test';

import Board from './board.js';
import Engine, { ENGINE_EVALUATORS } from './engine.js';
import { MATE_SCORE } from './search.js';

const FILES = 'abcdefgh';

function moveToUci(move) {
    return `${FILES[move.x1]}${8 - move.y1}${FILES[move.x2]}${8 - move.y2}`;
}

function play(board, moves) {
    for (const move of moves) {
        assert.equal(board.move(...move), true, `setup move ${move.join(',')} should be legal`);
    }
}

test('plays a checkmate found exactly at the depth-one horizon', () => {
    const board = new Board(0, { silent: true });
    play(board, [
        [5, 6, 5, 5], // f2-f3
        [4, 1, 4, 3], // e7-e5
        [6, 6, 6, 4], // g2-g4
    ]);

    const engine = new Engine(board, 1, ENGINE_EVALUATORS.CLASSICAL);
    const bestMove = engine.findBestMove(1);

    assert.equal(moveToUci(bestMove), 'd8h4');
    assert.equal(board.move(bestMove.x1, bestMove.y1, bestMove.x2, bestMove.y2), true);
    assert.equal(board.isCheckmate(0), true);
});

test('plays a depth-one checkmate as White too', () => {
    const board = new Board(1, { silent: true });
    play(board, [
        [4, 6, 4, 4], // e2-e4
        [4, 1, 4, 3], // e7-e5
        [5, 7, 2, 4], // Bf1-c4
        [1, 0, 2, 2], // Nb8-c6
        [3, 7, 7, 3], // Qd1-h5
        [6, 0, 5, 2], // Ng8-f6
    ]);

    const engine = new Engine(board, 0, ENGINE_EVALUATORS.CLASSICAL);
    const bestMove = engine.findBestMove(1);

    assert.equal(moveToUci(bestMove), 'h5f7');
    assert.equal(board.move(bestMove.x1, bestMove.y1, bestMove.x2, bestMove.y2), true);
    assert.equal(board.isCheckmate(1), true);
});

test('checkmate outranks every classical position score', () => {
    const board = new Board(0, { silent: true });
    const engine = new Engine(board, 0, ENGINE_EVALUATORS.CLASSICAL);

    assert.ok(Math.abs(engine.evaluateBoard()) < MATE_SCORE);
    assert.equal(Math.abs(engine.getCheckmateScore(1)), MATE_SCORE - 1);

    board.turn = 1;
    assert.equal(engine.getCheckmateScore(1), MATE_SCORE - 1);
    assert.ok(engine.getCheckmateScore(1) > engine.getCheckmateScore(3));

    board.turn = 0;
    assert.ok(engine.getCheckmateScore(1) < engine.getCheckmateScore(3));
});
