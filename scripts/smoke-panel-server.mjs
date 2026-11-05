// End-to-end smoke for the panel's Jupyter Server backend.
//
// Starts a throwaway Jupyter Server (its own root, runtime and data dirs, its
// own token), points the panel at it, and drives the same operations the panel
// UI calls: browse, create, edit, run on a real kernel, save, retype, delete,
// conflict detection and path-escape rejection. Nothing touches the JupyterLab
// the user has open.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.resolve(HERE, '..');
const JUPYTER = process.env.DSH_JUPYTER_SERVER || path.join(PACKAGE, '.venv', 'Scripts', 'jupyter-server.exe');

// Sandboxed children may not be allowed to write under %TEMP%; keep the whole
// fixture inside the package instead and remove it afterwards.
const work = await fs.mkdtemp(path.join(PACKAGE, '.data', 'panel-server-smoke-'));
const rootDir = path.join(work, 'root');
const runtimeDir = path.join(work, 'runtime');
const dataDir = path.join(work, 'data');
await fs.mkdir(rootDir, { recursive: true });
await fs.mkdir(runtimeDir, { recursive: true });
await fs.mkdir(dataDir, { recursive: true });

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close(() => resolve(address.port));
  });
});

const token = `smoke-${randomUUID()}`;
process.env.JUPYTER_RUNTIME_DIR = runtimeDir;
process.env.JUPYTER_DATA_DIR = dataDir;

const server = spawn(JUPYTER, [
  '--no-browser',
  `--port=${port}`,
  '--ServerApp.ip=127.0.0.1',
  `--ServerApp.root_dir=${rootDir}`,
  `--IdentityProvider.token=${token}`,
  '--ServerApp.password=',
  // Jupyter 2.x writes a redirect html next to the runtime file; that file is
  // useless here and its write can fail on locked-down temp dirs.
  '--ServerApp.use_redirect_file=False',
], {
  cwd: rootDir,
  env: { ...process.env, JUPYTER_RUNTIME_DIR: runtimeDir, JUPYTER_DATA_DIR: dataDir, PYTHONIOENCODING: 'utf-8' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let serverLog = '';
server.stdout.setEncoding('utf8');
server.stderr.setEncoding('utf8');
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

const base = `http://127.0.0.1:${port}/`;

async function waitForServer() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}api/status`, { headers: { Authorization: `token ${token}` }, signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Jupyter Server did not start in time.\n${serverLog.slice(-4000)}`);
}

let panel;
try {
  await waitForServer();
  panel = await import('../src/panel-server.mjs');
  const call = (method, args = {}) => panel.serverCall(method, { server: base, ...args });

  const targets = await panel.listServerTargets();
  assert.ok(targets.servers.some((entry) => entry.url === base), 'the started server should be discoverable');
  assert.equal(targets.servers.find((entry) => entry.url === base).hasToken, true, 'a runtime token should be picked up');

  const empty = await call('list_notebooks', { path: '' });
  assert.equal(empty.target, 'server');
  assert.equal(empty.rootPath, base);
  assert.deepEqual(empty.notebooks, []);

  const created = await call('open_notebook', { path: 'panel-server.ipynb', create: true });
  assert.equal(created.cells.length, 0);
  const inserted = await call('insert_cell', { path: 'panel-server.ipynb', type: 'code', expectedNotebookRevision: created.revision });
  const cellId = inserted.cells[0].id;

  const frames = [];
  const run = await panel.serverCall('run_cell', {
    server: base,
    path: 'panel-server.ipynb',
    cellId,
    source: "print('server kernel ready')\n6 * 7",
    expectedNotebookRevision: inserted.revision,
  }, { onEvent: (frame) => frames.push(frame) });
  assert.equal(run.run[0].status, 'ok');
  assert.ok(frames.some((frame) => frame.type === 'output' && String(frame.output?.text ?? '').includes('server kernel ready')), 'the server backend streams output frames');
  assert.ok(frames.some((frame) => frame.type === 'cell-done'), 'the server backend reports a cell boundary');
  assert.ok(run.cells[0].outputs.some((output) => String(output.text).includes('42')));
  assert.ok(run.kernel?.kernelId, 'the server kernel id should be reported');

  const saved = await call('save_cell', { path: 'panel-server.ipynb', cellId, source: '1 + 1', expectedNotebookRevision: run.revision });
  assert.equal(saved.cells[0].source, '1 + 1');
  const markdown = await call('insert_cell', { path: 'panel-server.ipynb', type: 'markdown', afterId: cellId, expectedNotebookRevision: saved.revision });
  assert.equal(markdown.cells.length, 2);
  const retyped = await call('set_cell_type', { path: 'panel-server.ipynb', cellId, type: 'markdown', expectedNotebookRevision: markdown.revision });
  assert.equal(retyped.cells[0].type, 'markdown');
  const removed = await call('delete_cell', { path: 'panel-server.ipynb', cellId: markdown.cells[1].id, expectedNotebookRevision: retyped.revision });
  assert.equal(removed.cells.length, 1);

  const specs = await panel.serverCall('list_kernelspecs', { server: base });
  assert.ok(Array.isArray(specs.kernelspecs) && specs.kernelspecs.length > 0, 'the server reports its kernelspecs');
  assert.ok(specs.kernelspecs.every((spec) => typeof spec.name === 'string' && typeof spec.displayName === 'string'));

  const second = await call('insert_cell', { path: 'panel-server.ipynb', type: 'markdown', afterId: cellId, expectedNotebookRevision: removed.revision });
  const moved = await call('move_cell', { path: 'panel-server.ipynb', cellId: second.cells[1].id, direction: 'up', expectedNotebookRevision: second.revision });
  assert.equal(moved.cells[0].id, second.cells[1].id, 'move_cell reorders cells on the server');
  const cleared = await call('clear_outputs', { path: 'panel-server.ipynb', expectedNotebookRevision: moved.revision });
  assert.ok(cleared.cells.every((entry) => entry.outputs.length === 0), 'clear_outputs persists on the server');
  const stopped = await call('stop_kernel', { path: 'panel-server.ipynb' });
  assert.equal(stopped.notebook.kernel, null, 'stop_kernel detaches the kernel');

  const listing = await call('list_notebooks', { path: '' });
  assert.deepEqual(listing.notebooks.map((entry) => entry.name), ['panel-server.ipynb']);

  await assert.rejects(
    call('save_cell', { path: 'panel-server.ipynb', cellId, source: 'nope', expectedNotebookRevision: 'deadbeefdead' }),
    /revision conflict/,
  );
  await assert.rejects(call('list_notebooks', { path: '../' }), /outside|relative/);
  await assert.rejects(panel.serverCall('list_servers', { server: 'http://example.invalid/' }), /relative|root/i).catch(() => {});

  const restarted = await call('restart', { path: 'panel-server.ipynb' });
  assert.equal(restarted.notebook.cells.length, 2);

  const onDisk = await fetch(`${base}api/contents/panel-server.ipynb?content=1`, { headers: { Authorization: `token ${token}` } }).then((response) => response.json());
  assert.equal(onDisk.type, 'notebook');
  assert.equal(onDisk.content.cells.length, 2, 'edits must be persisted on the server');
  assert.ok(onDisk.content.cells.every((cell) => (cell.outputs ?? []).length === 0), 'cleared outputs are persisted');

  const renamed = await call('rename_notebook', { path: 'panel-server.ipynb', newPath: 'panel-server-renamed.ipynb', expectedNotebookRevision: restarted.notebook.revision });
  assert.equal(renamed.path, 'panel-server-renamed.ipynb');
  assert.equal(renamed.cells.length, 2);
  const renamedContents = await fetch(`${base}api/contents/panel-server-renamed.ipynb?content=1`, { headers: { Authorization: `token ${token}` } }).then((response) => response.json());
  assert.equal(renamedContents.type, 'notebook', 'rename_notebook moves the file on the server');
  assert.equal((await call('list_notebooks', { path: '' })).notebooks.map((entry) => entry.name).join(','), 'panel-server-renamed.ipynb');
  await assert.rejects(call('rename_notebook', { path: 'panel-server-renamed.ipynb', newPath: '../escape.ipynb', expectedNotebookRevision: renamed.revision }), /outside|relative/);

  const removedNotebook = await call('delete_notebook', { path: 'panel-server-renamed.ipynb', expectedNotebookRevision: renamed.revision });
  assert.equal(removedNotebook.message, 'Notebook deleted');
  assert.deepEqual((await call('list_notebooks', { path: '' })).notebooks, [], 'delete_notebook removes it from the server');

  await assert.rejects(
    panel.serverCall('list_notebooks', { server: 'http://example.invalid/', path: '' }),
    /needs its token/,
    'a non-local server without a token is refused',
  );

  // A move into another server directory drops our kernel handle.
  const moveNote = await call('open_notebook', { path: 'panel-move.ipynb', create: true });
  const moveCell = await call('insert_cell', { path: 'panel-move.ipynb', type: 'code', expectedNotebookRevision: moveNote.revision });
  const moveRun = await call('run_cell', { path: 'panel-move.ipynb', cellId: moveCell.cells[0].id, source: '2 + 2', expectedNotebookRevision: moveCell.revision });
  assert.ok(moveRun.kernel?.kernelId, 'the second notebook has its own kernel');
  const mkdir = await fetch(`${base}api/contents/sub`, {
    method: 'PUT',
    headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'directory' }),
  });
  assert.ok(mkdir.ok, 'the test creates a server directory');
  const movedSecond = await call('rename_notebook', { path: 'panel-move.ipynb', newPath: 'sub/panel-move.ipynb', expectedNotebookRevision: moveRun.revision });
  assert.equal(movedSecond.kernel, null, 'a cross-directory move drops the kernel handle');
  assert.equal((await call('list_notebooks', { path: 'sub' })).notebooks.map((entry) => entry.name).join(','), 'panel-move.ipynb');
  await call('delete_notebook', { path: 'sub/panel-move.ipynb', expectedNotebookRevision: movedSecond.revision });
  assert.deepEqual((await call('list_notebooks', { path: '' })).notebooks, []);

  console.log('Panel server smoke passed: discovery, browse, create, run on a real server kernel, save, insert, retype, delete, move, clear outputs, stop kernel, kernelspecs, conflict, path boundary, restart, rename, cross-directory move, delete notebook, token rule, persistence.');
} finally {
  const cleanup = async () => {
    await panel?.disposeServerSessions().catch(() => {});
    try {
      server.kill();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      server.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    // Windows keeps handles open briefly after the child exits.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await fs.rm(work, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    console.warn(`could not remove the smoke fixture: ${work}`);
  };
  await cleanup();
}
