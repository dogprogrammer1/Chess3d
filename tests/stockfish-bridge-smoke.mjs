import assert from 'node:assert/strict';

const port = Number(process.env.STOCKFISH_TEST_PORT || 8875);
const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
let completed = false;
const timeout = setTimeout(() => {
  socket.close();
  throw new Error('Stockfish bridge smoke test timed out.');
}, 15000);

socket.addEventListener('open', () => socket.send(JSON.stringify({
  type: 'analyse',
  requestId: 1,
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  depth: 4,
  multiPv: 3,
})));

socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  assert.equal(message.type, 'analysis');
  assert.equal(message.requestId, 1);
  assert.equal(message.lines.length, 3);
  assert.deepEqual(message.lines.map(line => line.rank), [1, 2, 3]);
  assert.ok(message.lines.every(line => line.pv && line.depth >= 4));
  completed = true;
  clearTimeout(timeout);
  socket.close();
  console.log('Stockfish bridge MultiPV smoke test passed.');
});

socket.addEventListener('error', () => {
  if (completed) return;
  clearTimeout(timeout);
  throw new Error('Could not connect to the Stockfish bridge smoke-test port.');
});
