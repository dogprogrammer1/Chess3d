import { pieceValues } from "./tables.js";

// Reserve a score range that no classical evaluation can overtake.
export const MATE_SCORE = 1_000_000;
const MATE_SCORE_THRESHOLD = MATE_SCORE - 1_000;

export const searchMethods = {
    findBestMove(depth) {
        const MAXDEPTH = 10;
        if(depth > MAXDEPTH) depth = MAXDEPTH;
        
        this.nodesEvaluated = 0;
        
        // Clear transposition table
        if (this.transpositionTable.size > 100000) {
            this.clearTranspositionTable();
        }
        
        const moves = this.board.generateLegalMoves(this.color);
        console.log(`Engine (color=${this.color}) generating moves, board.turn=${this.board.turn}, found ${moves.length} legal moves`);
        if (moves.length === 0) return null;
        
        // killer moves = best current at each depth :)
        this.killerMoves = Array(depth + 1).fill(null).map(() => []);
        
        let bestMove = moves[0];
        let previousIterationMoves = [];

        for (let currentDepth = 1; currentDepth <= depth; currentDepth++) {
            let tempBestScore = this.color === 0 ? -Infinity : Infinity;
            let tempBestMove = moves[0];

            this.sortMovesByPreviousResults(moves, previousIterationMoves);
            previousIterationMoves = [];

            for (const move of moves) {
                const undo = this.board.makeMove(move.x1, move.y1, move.x2, move.y2);
                this.board.turn = 1 - this.board.turn;
                const score = this.minimax(currentDepth - 1, -Infinity, Infinity, 1);
                this.board.unmakeMove(undo);
                
                if (this.color === 0) {
                    if (score > tempBestScore) {
                        tempBestScore = score;
                        tempBestMove = move;
                    }
                } else {
                    if (score < tempBestScore) {
                        tempBestScore = score;
                        tempBestMove = move;
                    }
                }
                
                previousIterationMoves.push({ move, score });
            }
            
            bestMove = tempBestMove;
        }
        
        return bestMove;
    },

    sortMovesByPreviousResults(moves, previousResults) {
        const resultMap = new Map();
        for (const result of previousResults) {
            const key = `${result.move.x1},${result.move.y1},${result.move.x2},${result.move.y2}`;
            resultMap.set(key, result.score);
        }
        moves.sort((a, b) => {
            const sa = resultMap.get(`${a.x1},${a.y1},${a.x2},${a.y2}`) ?? 0;
            const sb = resultMap.get(`${b.x1},${b.y1},${b.x2},${b.y2}`) ?? 0;
            return this.color === 0 ? sb - sa : sa - sb;
        });
    },

    getPieceValue(type) {
        return pieceValues[type] ?? 0;
    },

    getCheckmateScore(plyFromRoot) {
        return this.board.turn === 0
            ? -MATE_SCORE + plyFromRoot
            : MATE_SCORE - plyFromRoot;
    },

    scoreToTransposition(score, plyFromRoot) {
        if (score >= MATE_SCORE_THRESHOLD) return score + plyFromRoot;
        if (score <= -MATE_SCORE_THRESHOLD) return score - plyFromRoot;
        return score;
    },

    scoreFromTransposition(score, plyFromRoot) {
        if (score >= MATE_SCORE_THRESHOLD) return score - plyFromRoot;
        if (score <= -MATE_SCORE_THRESHOLD) return score + plyFromRoot;
        return score;
    },

    minimax(depth, alpha, beta, plyFromRoot = 0) {
        const maximizingPlayer = this.board.turn === 0;
        this.nodesEvaluated++;
        // Get zobrist hash for transposition table lookup
        const zobristHash = this.calculateZobristHash();

        // A checked side with no legal response is checkmated. This must be
        // tested before the depth cutoff so a mate on the horizon cannot be
        // mistaken for an ordinary static or cached evaluation.
        let moves = null;
        if (this.board.inCheck(this.board.turn)) {
            moves = this.board.generateLegalMoves(this.board.turn);
            if (moves.length === 0) {
                const score = this.getCheckmateScore(plyFromRoot);
                this.storeTransposition(
                    zobristHash,
                    depth,
                    this.scoreToTransposition(score, plyFromRoot),
                    0
                );
                return score;
            }
        }

        // Transposition table lookup
        const tabEntry = this.lookupTransposition(zobristHash, depth);
        if (tabEntry) {
            const tabScore = this.scoreFromTransposition(tabEntry.score, plyFromRoot);
            if (tabEntry.flag === 0) return tabScore; // Exact score
            if (tabEntry.flag === 1) alpha = Math.max(alpha, tabScore); // Lower bound
            if (tabEntry.flag === 2) beta = Math.min(beta, tabScore);  // Upper bound
            if (alpha >= beta) return tabScore;
        }

        // Use quiescence search at leaf nodes for better tactical evaluation
        if (depth === 0) {
            return this.quiescenceSearch(alpha, beta, 4, plyFromRoot);
        }

        moves ??= this.board.generateLegalMoves(this.board.turn);

        if (moves.length === 0) {
            // The checkmate case was handled above, so this is stalemate.
            this.storeTransposition(zobristHash, depth, 0, 0);
            return 0;
        }
        
        let value = maximizingPlayer ? -Infinity : Infinity;
        let bestMove = null;
        const alphaOrig = alpha;
        const betaOrig = beta;

        this.orderMoves(moves);

        for (const move of moves) {
            const undo = this.board.makeMove(move.x1, move.y1, move.x2, move.y2);
            this.board.turn = 1 - this.board.turn;
            const childValue = this.minimax(depth - 1, alpha, beta, plyFromRoot + 1);
            this.board.unmakeMove(undo);

            if (maximizingPlayer ? childValue > value : childValue < value) {
                value = childValue;
                bestMove = move;
            }
            if (maximizingPlayer) { alpha = Math.max(alpha, value); }
            else { beta = Math.min(beta, value); }
            if (alpha >= beta) break;
        }
        
        // Store in transposition table
        let flag = 0;
        if (value <= alphaOrig) flag = 2; // Upper bound
        else if (value >= betaOrig) flag = 1; // Lower bound
        else flag = 0; // Exact
        
        this.storeTransposition(
            zobristHash,
            depth,
            this.scoreToTransposition(value, plyFromRoot),
            flag,
            bestMove
        );
        
        return value;
    },

    quiescenceSearch(alpha, beta, depthRemaining = 4, plyFromRoot = 0) {
        const maximizingPlayer = this.board.turn === 0;
        const inCheck = this.board.inCheck(this.board.turn);
        let tacticalMoves;
        let value;

        if (inCheck) {
            tacticalMoves = this.board.generateLegalMoves(this.board.turn);
            if (tacticalMoves.length === 0) {
                return this.getCheckmateScore(plyFromRoot);
            }
            if (depthRemaining <= 0) return this.evaluateBoard();

            // Standing pat is not legal while in check, so search every evasion.
            value = maximizingPlayer ? -Infinity : Infinity;
        } else {
            const standPat = this.evaluateBoard();
            if (depthRemaining <= 0) return standPat;

            if (maximizingPlayer) {
                if (standPat >= beta) return beta;
                // Delta pruning: if even the best capture can't help, return early
                const deltaMargin = 900; // Queen value - largest expected gain
                if (standPat + deltaMargin < alpha) return alpha;
                alpha = Math.max(alpha, standPat);
            } else {
                if (standPat <= alpha) return alpha;
                const deltaMargin = 900;
                if (standPat - deltaMargin > beta) return beta;
                beta = Math.min(beta, standPat);
            }

            tacticalMoves = this.generateCaptureMoves(this.board.turn);
            if (tacticalMoves.length === 0) return standPat;
            value = standPat;
        }
        
        // Order captures (and any quiet check evasions) with MVV-LVA
        tacticalMoves.sort((a, b) => {
            const targetA = this.board.getPiece(a.x2, a.y2);
            const targetB = this.board.getPiece(b.x2, b.y2);
            const srcA = this.board.getPiece(a.x1, a.y1);
            const srcB = this.board.getPiece(b.x1, b.y1);
            
            const valueA = this.getPieceValue(targetA[1]) * 10 - this.getPieceValue(srcA[1]);
            const valueB = this.getPieceValue(targetB[1]) * 10 - this.getPieceValue(srcB[1]);
            return valueB - valueA;
        });
        
        for (const move of tacticalMoves) {
            const undo = this.board.makeMove(move.x1, move.y1, move.x2, move.y2);
            this.board.turn = 1 - this.board.turn;
            const childValue = this.quiescenceSearch(
                alpha,
                beta,
                depthRemaining - 1,
                plyFromRoot + 1
            );
            this.board.unmakeMove(undo);

            if (maximizingPlayer) {
                value = Math.max(value, childValue);
                alpha = Math.max(alpha, value);
            } else {
                value = Math.min(value, childValue);
                beta = Math.min(beta, value);
            }
            if (alpha >= beta) break;
        }
        return value;
    },

    generateCaptureMoves(color) {
        const moves = [];
        const originalTurn = this.board.turn;

        this.board.turn = color;

        for (const piece of this.board.getPieces()) {
            if (piece.color !== color) {
                continue;
            }

            const candidates = this.board.generateCandidateMovesForPiece(
                piece.x,
                piece.y,
                piece.color,
                piece.type
            );

            for (const move of candidates) {
                const isDirectCapture = this.board.enemyColor(move.x2, move.y2, color);
                const isEnPassantCapture =
                    piece.type === 0 &&
                    move.x1 !== move.x2 &&
                    move.x2 === this.board.enPassant[0] &&
                    move.y2 === this.board.enPassant[1];

                if (
                    (isDirectCapture || isEnPassantCapture) &&
                    this.board.canGetTo(move.x1, move.y1, move.x2, move.y2) &&
                    this.isMoveKingSafe(move, color)
                ) {
                    moves.push(move);
                }
            }
        }

        this.board.turn = originalTurn;
        return moves;
    },

    isMoveKingSafe(move, color) {
        const undo = this.board.makeMove(move.x1, move.y1, move.x2, move.y2);
        const isSafe = !this.board.inCheck(color);
        this.board.unmakeMove(undo);
        return isSafe;
    },

    orderMoves(moves) {
        const scores = new Map();
        for (const move of moves) {
            const target = this.board.getPiece(move.x2, move.y2);
            const source = this.board.getPiece(move.x1, move.y1);
            scores.set(move, target[1] !== -1
                ? this.getPieceValue(target[1]) * 10 - this.getPieceValue(source[1])
                : 0);
        }
        moves.sort((a, b) => scores.get(b) - scores.get(a));
    }
};
