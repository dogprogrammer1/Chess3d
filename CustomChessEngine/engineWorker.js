import Board from "./board.js";
import Engine, { ENGINE_EVALUATORS } from "./engine.js";

async function handleFindBestMove(message) {
  try {
    const board = new Board(0, { silent: true });
    board.restoreState(message.state);
    const workerEngine = new Engine(
      board,
      message.color,
      ENGINE_EVALUATORS.CLASSICAL
    );

    const start = performance.now();
    const bestMove = workerEngine.findBestMove(message.depth);
    const elapsedMs = performance.now() - start;
    self.postMessage({
      type: "bestMove",
      bestMove,
      color: message.color,
      evaluator: workerEngine.evaluator,
      requestedEvaluator: ENGINE_EVALUATORS.CLASSICAL,
      elapsedMs,
      nodesEvaluated: workerEngine.nodesEvaluated,
      evalCount: workerEngine.evalCount,
      evalTimeMs: workerEngine.evalTimeMs
    });
  } catch (error) {
    self.postMessage({ type: "error", message: error.message, stack: error.stack });
  }
}

self.addEventListener("message", event => {
  const message = event.data;
  if (message.type !== "findBestMove") {
    return;
  }

  void handleFindBestMove(message);
});
