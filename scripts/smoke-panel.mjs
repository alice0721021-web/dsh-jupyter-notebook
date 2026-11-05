import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { disposePanelSessions, panelCall } from '../src/panel-service.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.resolve(HERE, '..');
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-notebook-panel-'));
const options = { root: ROOT, packageRoot: PACKAGE, python: process.env.DSH_JUPYTER_PYTHON || path.join(PACKAGE, '.venv', 'Scripts', 'python.exe') };
const call = (method, args = {}) => panelCall(method, args, options);

try {
  const created = await call('open_notebook', { path: 'panel-smoke.ipynb', create: true });
  assert.equal(created.cells.length, 0);
  const inserted = await call('insert_cell', { path: 'panel-smoke.ipynb', type: 'code', expectedNotebookRevision: created.revision });
  const cellId = inserted.cells[0].id;
  const result = await call('run_cell', { path: 'panel-smoke.ipynb', cellId, source: "print('panel kernel ready')\n40 + 2", expectedNotebookRevision: inserted.revision });
  assert.equal(result.run[0].status, 'ok');
  assert.match(result.cells[0].source, /panel kernel ready/);
  assert.ok(result.cells[0].outputs.some((output) => output.text.includes('42')));
  const edited = await call('save_cell', { path: 'panel-smoke.ipynb', cellId, source: '42', expectedNotebookRevision: result.revision });
  assert.equal(edited.cells[0].source, '42');
  const afterInsert = await call('insert_cell', { path: 'panel-smoke.ipynb', type: 'markdown', afterId: cellId, expectedNotebookRevision: edited.revision });
  const markdownId = afterInsert.cells[1].id;
  const afterType = await call('set_cell_type', { path: 'panel-smoke.ipynb', cellId: cellId, type: 'markdown', expectedNotebookRevision: afterInsert.revision });
  assert.equal(afterType.cells[0].type, 'markdown');
  const afterDelete = await call('delete_cell', { path: 'panel-smoke.ipynb', cellId: markdownId, expectedNotebookRevision: afterType.revision });
  assert.equal(afterDelete.cells.length, 1);
  const diskNotebook = JSON.parse(await fs.readFile(path.join(ROOT, 'panel-smoke.ipynb'), 'utf8'));
  diskNotebook.cells[0].metadata.externalEdit = true;
  await fs.writeFile(path.join(ROOT, 'panel-smoke.ipynb'), JSON.stringify(diskNotebook, null, 1));
  await assert.rejects(call('save_cell', { path: 'panel-smoke.ipynb', cellId, source: '999', expectedNotebookRevision: afterDelete.revision }), /changed on disk/);
  const reloaded = await call('read_notebook', { path: 'panel-smoke.ipynb' });
  assert.equal(reloaded.cells.length, 1);
  assert.equal(reloaded.kernel, null, 'reload must discard the kernel whose state no longer matches the file');
  const afterReload = await call('save_cell', { path: 'panel-smoke.ipynb', cellId, source: '7 * 6', expectedNotebookRevision: reloaded.revision });
  assert.equal(afterReload.cells[0].source, '7 * 6');

  const second = await call('insert_cell', { path: 'panel-smoke.ipynb', type: 'markdown', afterId: cellId, expectedNotebookRevision: afterReload.revision });
  assert.equal(second.cells.length, 2);
  const moved = await call('move_cell', { path: 'panel-smoke.ipynb', cellId: second.cells[1].id, direction: 'up', expectedNotebookRevision: second.revision });
  assert.equal(moved.cells[0].id, second.cells[1].id, 'move_cell reorders the cells');
  const backDown = await call('move_cell', { path: 'panel-smoke.ipynb', cellId: second.cells[1].id, direction: 'down', expectedNotebookRevision: moved.revision });
  assert.equal(backDown.cells[1].id, second.cells[1].id, 'move_cell moves back down');
  const cleared = await call('clear_outputs', { path: 'panel-smoke.ipynb', expectedNotebookRevision: backDown.revision });
  assert.ok(cleared.cells.every((entry) => entry.outputs.length === 0), 'clear_outputs empties every code cell');
  const stopped = await call('stop_kernel', { path: 'panel-smoke.ipynb' });
  assert.equal(stopped.notebook.kernel, null, 'stop_kernel disposes the kernel');

  const restarted = await call('restart', { path: 'panel-smoke.ipynb' });
  assert.equal(restarted.notebook.cells.length, 2);
  const lists = await call('list_notebooks', { path: '.' });
  assert.deepEqual(lists.notebooks.map((entry) => entry.name), ['panel-smoke.ipynb']);
  assert.equal(lists.rootPath, ROOT);
  await assert.rejects(call('list_notebooks', { path: '..' }), /outside/);

  // Same-directory rename keeps the kernel; a move into another directory must
  // drop it, because the kernel's cwd would point at the old place.
  const extra = await call('insert_cell', { path: 'panel-smoke.ipynb', type: 'code', expectedNotebookRevision: restarted.notebook.revision });
  const codeId = extra.cells[extra.cells.length - 1].id;
  const running = await call('run_cell', { path: 'panel-smoke.ipynb', cellId: codeId, source: '1 + 1', expectedNotebookRevision: extra.revision });
  assert.ok(running.kernel, 'the cell run started a kernel');
  await fs.mkdir(path.join(ROOT, 'sub'), { recursive: true });
  const movedDir = await call('rename_notebook', { path: 'panel-smoke.ipynb', newPath: 'sub/panel-smoke.ipynb', expectedNotebookRevision: running.revision });
  assert.equal(movedDir.path, 'sub/panel-smoke.ipynb');
  assert.equal(movedDir.cells.length, 3);
  assert.equal(movedDir.kernel, null, 'a cross-directory rename drops the kernel');
  assert.deepEqual((await call('list_notebooks', { path: 'sub' })).notebooks.map((entry) => entry.name), ['panel-smoke.ipynb']);
  assert.deepEqual((await call('list_notebooks', { path: '.' })).notebooks, []);

  const renamed = await call('rename_notebook', { path: 'sub/panel-smoke.ipynb', newPath: 'sub/panel-smoke-renamed.ipynb', expectedNotebookRevision: movedDir.revision });
  assert.equal(renamed.path, 'sub/panel-smoke-renamed.ipynb');
  assert.equal(renamed.cells.length, 3);
  assert.ok(await fs.stat(path.join(ROOT, 'sub', 'panel-smoke-renamed.ipynb')).then(() => true).catch(() => false), 'rename_notebook moves the file');
  assert.deepEqual((await call('list_notebooks', { path: 'sub' })).notebooks.map((entry) => entry.name), ['panel-smoke-renamed.ipynb']);
  await assert.rejects(call('rename_notebook', { path: 'sub/panel-smoke-renamed.ipynb', newPath: '../escape.ipynb', expectedNotebookRevision: renamed.revision }), /outside|required/);
  await assert.rejects(call('rename_notebook', { path: 'sub/panel-smoke-renamed.ipynb', newPath: 'sub/panel-smoke-renamed.txt', expectedNotebookRevision: renamed.revision }), /\.ipynb/);

  const deleted = await call('delete_notebook', { path: 'sub/panel-smoke-renamed.ipynb', expectedNotebookRevision: renamed.revision });
  assert.equal(deleted.message, 'Notebook deleted');
  assert.equal(await fs.stat(path.join(ROOT, 'sub', 'panel-smoke-renamed.ipynb')).then(() => true).catch(() => false), false, 'delete_notebook removes the file');
  assert.deepEqual((await call('list_notebooks', { path: 'sub' })).notebooks, []);

  console.log('Panel bridge smoke passed: create, edit, kernel run, insert, type change, delete, disk conflict, reload, move, clear outputs, stop kernel, restart, rename, cross-directory move, delete notebook, listing, path boundary.');
} finally {
  await disposePanelSessions();
  await fs.rm(ROOT, { recursive: true, force: true });
}
