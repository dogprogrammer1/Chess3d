import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const page = new URL('https://example.test/portfolio/Chess3d/');
const read = relative => readFileSync(new URL(relative, root), 'utf8');

// Supply only the DOM operations the controls use. Returning null for WebGL
// exercises the same square buttons available on a machine without a GPU.
class Element extends EventTarget {
  children = [];
  dataset = {};
  style = {};
  value = '';
  textContent = '';
  classList = { add() {}, remove() {}, toggle() {} };
  attributes = new Map();

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  replaceWith(element) { this.parentElement.replaceChildren(element); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  focus() { this.dispatchEvent(new Event('focus')); }
  getContext() { return null; }
  click() { this.dispatchEvent(new Event('click')); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

// The Node worker loads the same module and engine imports as the browser.
const workerBootstrap = new URL('data:text/javascript,' + encodeURIComponent(`
  import { parentPort, workerData } from 'node:worker_threads';
  globalThis.self = {
    addEventListener: (_, handler) => parentPort.on('message', data => handler({data})),
    postMessage: data => parentPort.postMessage(data)
  };
  await import(workerData);
`));
class BrowserWorker {
  constructor(url, options) {
    assert.equal(url.href, new URL('js/engines/custom-engine-worker.js', page).href);
    assert.equal(options.type, 'module');
    this.worker = new Worker(workerBootstrap, { workerData: new URL('js/engines/custom-engine-worker.js', root).href });
  }
  addEventListener(type, listener) {
    this.worker.on(type, data => listener(type === 'message' ? { data } : data));
  }
  postMessage(message) { this.worker.postMessage(message); }
  terminate() { this.worker.terminate(); }
}

function launch(t) {
  const html = read('index.html');
  const elements = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => {
    const element = new Element();
    element.hidden = /\bhidden\b/.test(tag);
    return [id, element];
  }));
  const get = id => elements.get(id);
  for (const [, id, options] of html.matchAll(/<select id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const tags = [...options.matchAll(/<option value="([^"]+)"([^>]*)>/g)];
    get(id).value = (tags.find(match => match[2].includes('selected')) || tags[0])?.[1] || '';
  }
  const rails = new Map();
  const document = {
    documentElement: { dataset: { bridgePort: '8765', roomPort: '8766', groundingPort: '8770' } },
    createElement: () => new Element(), getElementById: get,
    querySelector(selector) {
      if (!rails.has(selector)) rails.set(selector, new Element());
      return rails.get(selector);
    },
  };
  get('chessboard').parentElement = get('board-wrap');
  const sockets = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    constructor(url) { super(); this.url = url; sockets.push(this); }
  }
  const window = new EventTarget();
  window.localStorage = { getItem: () => null, setItem() {} };
  const context = vm.createContext({
    window, document, URL, Worker: BrowserWorker, WebSocket: Socket, console,
    performance, setTimeout, clearTimeout, localStorage: window.localStorage,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    fetch: async relative => {
      assert.equal(new URL(relative, page).href, new URL('data/openings/openings.json', page).href);
      return { ok: true, json: async () => JSON.parse(read(relative)) };
    },
  });
  for (const [, src] of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    document.currentScript = { src: new URL(src, page).href };
    vm.runInContext(read(src), context, { filename: src });
  }
  window.dispatchEvent(new Event('DOMContentLoaded'));
  const room = window.tournamentRoom;
  t.after(() => { room.cancelEngineSearch(); room.clock?.dispose(); clearTimeout(room.toastTimer); });
  const square = name => room.renderer.element.children.find(button => button.attributes.get('aria-label')?.startsWith(name + ','));
  return { room, get, square, sockets };
}

async function waitFor(check) {
  const end = performance.now() + 5000;
  while (!check() && performance.now() < end) await delay(10);
  assert.ok(check(), 'expected the app to finish updating');
}

test('the analysis board searches the README position without moving either side', async t => {
  const { room, get, square, sockets } = launch(t);
  get('launch-analysis').click();
  const right = new Event('keydown', { cancelable: true });
  Object.defineProperty(right, 'key', { value: 'ArrowRight' });
  square('a8').dispatchEvent(right);
  assert.equal(square('b8').tabIndex, 0);
  assert.equal(square('a8').tabIndex, -1);
  get('engine-depth').value = '1';
  get('engine-depth').dispatchEvent(new Event('input'));
  for (const name of ['f2', 'f3', 'e7', 'e5', 'g2', 'g4']) square(name).click();
  await waitFor(() => get('pv-line').textContent.includes('Qh4# (d8h4)'));
  assert.equal(get('eval-score').textContent, '-1.67');
  assert.equal(room.game.history.length, 3);
  assert.equal(sockets.length, 0);
  square('d8').click(); square('h4').click();
  assert.match(room.game.result, /Black wins/);
  assert.equal(get('eval-score').textContent, '—');
  get('undo-move').click();
  await waitFor(() => get('pv-line').textContent.includes('Qh4#'));
});

test('a custom tournament waits for the player clock and plays a legal reply', async t => {
  const { room, get, square } = launch(t);
  get('launch-tournament-setup').click();
  get('open-tournament-rules').click();
  get('rules-start').click();
  get('engine-depth').value = '1';
  get('engine-depth').dispatchEvent(new Event('input'));
  square('e2').click(); square('e4').click();
  assert.equal(room.clock.activeColor, 'w');
  assert.ok(room.tournament.awaitingClockPress);
  get('white-clock').click();
  await waitFor(() => room.game.history.length === 2);
  assert.equal(room.clock.activeColor, 'w');
  assert.equal(room.game.turn, 'w');
});

test('a failed tournament connection can start the clock after a successful retry', async t => {
  const { room, get, sockets } = launch(t);
  get('tournament-opponent').value = 'stockfish';
  get('launch-tournament-setup').click();
  get('open-tournament-rules').click();
  get('rules-start').click();
  sockets[0].readyState = 3;
  sockets[0].dispatchEvent(new Event('error'));
  assert.equal(room.clock.activeColor, null);
  assert.equal(get('tournament-reconnect').hidden, false);
  get('tournament-reconnect').click();
  sockets[1].readyState = 1;
  sockets[1].dispatchEvent(new Event('open'));
  sockets[0].dispatchEvent(new Event('close'));
  await waitFor(() => room.clock.activeColor === 'w');
  assert.equal(room.tournament.waitingForEngine, false);
  assert.equal(get('tournament-reconnect').hidden, true);
});

test('opening lessons load under a project subdirectory and advance the board', async t => {
  const { room, get } = launch(t);
  get('launch-opening-prep').click();
  await waitFor(() => Boolean(room.openingPrep.chapter));
  get('opening-next').click();
  assert.equal(room.game.history[0].san, 'e4');
  assert.equal(room.openingPrep.openings.length, 6);
});
