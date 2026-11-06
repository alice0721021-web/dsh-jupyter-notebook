// Route-level checks for the panel's Host API: request gating, dispatch and
// the streaming response. The handler is mounted on a fake web server, so the
// whole path runs without a running Harness — including the security checks
// that a browser-only test could not reach.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.js';
import { disposePanelSessions } from '../src/panel-service.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.resolve(HERE, '..');
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-route-'));
const PYTHON = process.env.DSH_JUPYTER_PYTHON || path.join(PACKAGE, '.venv', 'Scripts', 'python.exe');

const routes = [];
/** Stands in for the Host Connection service; the route must fail closed without it. */
let connection;
const ctx = {
  effect(fn) { fn(); return () => {}; },
  webServer: { register(route) { routes.push(route); return () => {}; } },
  get(name) { return name === 'connection' ? connection : undefined; },
};
connection = { requestRejection: () => undefined };
apply(ctx, { root: ROOT, python: PYTHON });
assert.equal(routes.length, 1, 'the plugin registers exactly one route');
assert.equal(routes[0].path, '/api/dsh-jupyter-notebook');
const handler = routes[0].handler;

function response() {
  const chunks = [];
  return {
    statusCode: 0,
    headers: {},
    ended: false,
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers ?? {}); },
    write(chunk) { chunks.push(String(chunk)); return true; },
    end(body) { if (body !== undefined) chunks.push(String(body)); this.ended = true; },
    get body() { return chunks.join(''); },
  };
}

function request({ body = {}, headers = {}, method = 'POST' }) {
  const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield payload; },
  };
}

async function call(options) {
  const res = response();
  await handler(request(options), res);
  return res;
}

try {
  // Gate 0: the route is fail-closed without Host authentication.
  connection = undefined;
  const noAuth = await call({ body: { method: 'list_notebooks', args: { path: '.' } } });
  assert.equal(noAuth.statusCode, 401, 'a missing Connection service rejects every call');
  assert.match(noAuth.body, /authenticated Harness connection/);

  connection = { requestRejection: () => 403 };
  const rejected = await call({ body: { method: 'list_notebooks', args: { path: '.' } } });
  assert.equal(rejected.statusCode, 403, 'Connection rejections are passed through');
  connection = { requestRejection: () => 401 };
  const unauthorized = await call({ body: { method: 'list_notebooks', args: { path: '.' } } });
  assert.equal(unauthorized.statusCode, 401);

  let seenHeaders = null;
  connection = { requestRejection: (input) => { seenHeaders = input?.headers; return undefined; } };
  const admitted = await call({ body: { method: 'list_notebooks', args: { path: '.' } } });
  assert.equal(admitted.statusCode, 200, 'an accepted request continues');
  assert.equal(seenHeaders['content-type'], 'application/json', 'the request headers reach Connection');
  connection = { requestRejection: () => undefined };

  // Gate 1: a cross-site form can only send text/plain, which is refused.
  const plain = await call({ headers: { 'content-type': 'text/plain' }, body: { method: 'list_notebooks', args: { path: '.' } } });
  assert.equal(plain.statusCode, 403, 'non-JSON content type is refused');
  assert.match(plain.body, /application\/json/);

  // Gate 2: a non-local Origin is refused even with a valid body.
  const crossOrigin = await call({ headers: { origin: 'https://evil.example' }, body: { method: 'list_notebooks', args: { path: '.' } } });
  assert.equal(crossOrigin.statusCode, 403, 'a foreign Origin is refused');
  assert.match(crossOrigin.body, /local page/);

  // A local Origin is the panel itself and passes.
  const sameOrigin = await call({ headers: { origin: 'http://127.0.0.1:1234' }, body: { method: 'list_notebooks', args: { path: '.' } } });
  assert.equal(sameOrigin.statusCode, 200, 'a local Origin passes');
  assert.equal(JSON.parse(sameOrigin.body).result.rootPath, ROOT);

  const get = await call({ method: 'GET' });
  assert.equal(get.statusCode, 405, 'only POST is served');
  assert.match(get.body, /POST required/);

  const badMethod = await call({ body: { method: 'rm_rf', args: { path: 'x' } } });
  assert.equal(badMethod.statusCode, 400);
  assert.match(badMethod.body, /unsupported panel operation/);

  const escape = await call({ body: { method: 'list_notebooks', args: { path: '..' } } });
  assert.equal(escape.statusCode, 400);
  assert.match(escape.body, /outside/);

  // Streaming run through the route: NDJSON frames, then a final result.
  const created = JSON.parse((await call({ body: { method: 'open_notebook', args: { path: 'route.ipynb', create: true } } })).body).result;
  const inserted = JSON.parse((await call({ body: { method: 'insert_cell', args: { path: 'route.ipynb', type: 'code', expectedNotebookRevision: created.revision } } })).body).result;
  const streamed = await call({
    body: {
      method: 'run_cell',
      stream: true,
      args: {
        path: 'route.ipynb',
        cellId: inserted.cells[0].id,
        source: "print('route stream')\n7 * 6",
        expectedNotebookRevision: inserted.revision,
      },
    },
  });
  assert.equal(streamed.statusCode, 200);
  assert.match(streamed.headers['content-type'], /application\/x-ndjson/);
  const frames = streamed.body.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(frames.some((frame) => frame.type === 'cell-start'), 'stream reports the cell start');
  assert.ok(frames.some((frame) => frame.type === 'output' && String(frame.output?.text ?? '').includes('route stream')), 'stream carries output frames');
  const final = frames.find((frame) => frame.type === 'result');
  assert.ok(final, 'stream ends with the resulting notebook');
  assert.ok(final.result.cells[0].outputs.some((output) => String(output.text).includes('42')));
  assert.ok(frames[frames.length - 1].type === 'result', 'the result frame is last');

  // A non-streaming call keeps the plain JSON contract.
  const plainRead = await call({ body: { method: 'read_notebook', args: { path: 'route.ipynb' } } });
  assert.equal(plainRead.statusCode, 200);
  assert.match(plainRead.headers['content-type'], /application\/json/);
  assert.equal(JSON.parse(plainRead.body).result.cells.length, 1);

  // Notebook-level operations go through the same route.
  const renamed = JSON.parse((await call({ body: { method: 'rename_notebook', args: { path: 'route.ipynb', newPath: 'route-renamed.ipynb', expectedNotebookRevision: final.result.revision } } })).body).result;
  assert.equal(renamed.path, 'route-renamed.ipynb', 'rename_notebook returns the new path');
  const deleted = JSON.parse((await call({ body: { method: 'delete_notebook', args: { path: 'route-renamed.ipynb', expectedNotebookRevision: renamed.revision } } })).body).result;
  assert.equal(deleted.message, 'Notebook deleted');
  assert.deepEqual(JSON.parse((await call({ body: { method: 'list_notebooks', args: { path: '.' } } })).body).result.notebooks, []);

  // A non-local server without a token is refused before any request is made.
  const tokenRule = await call({ body: { method: 'list_notebooks', args: { server: 'http://example.invalid/', path: '' } } });
  assert.equal(tokenRule.statusCode, 400);
  assert.match(tokenRule.body, /needs its token/);

  console.log('Panel route checks passed: Connection authentication (fail-closed), content-type gate, Origin gate, method guard, dispatch, path boundary, NDJSON streaming, JSON contract, rename, delete, remote token rule.');
} finally {
  await disposePanelSessions();
  await fs.rm(ROOT, { recursive: true, force: true });
}
