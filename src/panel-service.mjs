import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { emptyNotebook, ensureCellIds, newCell, notebookFingerprint, readNotebook, revisionOf, setText, textOf, writeNotebook } from './notebook.mjs';
import { viewCells, viewOutput, viewOutputs } from './notebook-view.mjs';
import { NotebookKernel } from './kernel.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sessions = new Map();
const kernelsByPath = new Map();
const rootLocks = new Map();
const ROOT = path.resolve(process.env.DSH_JUPYTER_ROOT || (process.platform === 'win32' ? 'F:\\FJ' : process.cwd()));

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolvePath(value, root) {
  const target = String(value ?? '').trim();
  if (!target) throw new Error('path is required');
  const absolute = path.resolve(root, target);
  if (!within(root, absolute)) throw new Error('path is outside the configured notebook root');
  return absolute;
}

async function resolveSafePath(value, root) {
  const absolute = resolvePath(value, root);
  const relative = path.relative(root, absolute);
  let cursor = root;
  const parts = relative ? relative.split(path.sep) : [];
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    const info = await fs.lstat(cursor).catch(() => null);
    if (!info) {
      if (index < parts.length - 1) throw new Error('notebook folder not found');
      break;
    }
    if (info.isSymbolicLink()) throw new Error('symbolic links are not followed by the notebook panel');
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error('notebook folder not found');
  }
  return absolute;
}

async function requireRevision(filePath, expectedRevision) {
  const current = await readNotebook(filePath);
  if (expectedRevision !== undefined) {
    if (typeof expectedRevision !== 'string' || !expectedRevision) throw new Error('invalid notebook revision');
    if (expectedRevision !== current.revision) throw new Error('notebook revision conflict; reload before continuing');
  }
  const session = sessions.get(filePath);
  if (session?.diskFingerprint && session.diskFingerprint !== notebookFingerprint(current.nb)) {
    throw new Error('notebook changed on disk; reload before continuing');
  }
}

function serialize(filePath, operation) {
  const previous = rootLocks.get(filePath) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  const tracked = current.finally(() => {
    if (rootLocks.get(filePath) === tracked) rootLocks.delete(filePath);
  });
  rootLocks.set(filePath, tracked);
  return tracked;
}

function label(root, target) {
  return path.relative(root, target).split(path.sep).join('/') || '.';
}

async function load(filePath) {
  let session = sessions.get(filePath);
  if (!session) {
    session = { path: filePath, kernel: kernelsByPath.get(filePath) ?? null, lastTouched: Date.now() };
    sessions.set(filePath, session);
  }
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) {
    if (session.kernel?.alive) throw new Error('notebook disappeared while its kernel is alive; restart or stop the kernel before reopening');
    sessions.delete(filePath);
    kernelsByPath.delete(filePath);
    throw new Error(`notebook not found: ${filePath}`);
  }
  if (!stat.isFile() || !filePath.toLowerCase().endsWith('.ipynb')) {
    if (session.kernel?.alive) throw new Error('notebook path changed while its kernel is alive; restart or stop the kernel before reopening');
    sessions.delete(filePath);
    kernelsByPath.delete(filePath);
    throw new Error('only .ipynb files are supported');
  }
  const loaded = await readNotebook(filePath);
  const diskFingerprint = notebookFingerprint(loaded.nb);
  if (session.nb && diskFingerprint === session.diskFingerprint) {
    session.lastTouched = Date.now();
    return session;
  }
  if (session?.kernel?.busy) throw new Error('notebook changed on disk while its kernel was busy; interrupt or wait before reloading');
  if (session?.kernel?.alive) {
    await session.kernel.dispose().catch(() => {});
    session.kernel = null;
    kernelsByPath.delete(filePath);
    session.kernelDiscarded = true;
  }
  session.nb = loaded.nb;
  session.revision = loaded.revision;
  session.mtimeMs = loaded.mtimeMs;
  session.diskFingerprint = diskFingerprint;
  session.lastTouched = Date.now();
  if (session.kernel) kernelsByPath.set(filePath, session.kernel);
  return session;
}

async function save(session) {
  const written = await writeNotebook(session.path, session.nb);
  session.revision = written.revision;
  session.mtimeMs = written.mtimeMs;
  session.diskFingerprint = notebookFingerprint(session.nb);
  session.lastTouched = Date.now();
}

function cellIndex(session, id) {
  const index = session.nb.cells.findIndex((cell) => cell.id === id);
  if (index < 0) throw new Error(`no cell with id ${id}`);
  return index;
}

function notebookView(session, root) {
  return {
    path: label(root, session.path),
    revision: session.revision,
    cells: viewCells(session.nb.cells),
    kernel: session.kernel?.alive ? session.kernel.describe() : null,
    sessionId: createHash('sha1').update(session.path).digest('hex').slice(0, 10),
  };
}

function targetPosition(nb, afterId, beforeId) {
  if (afterId) {
    const index = nb.cells.findIndex((cell) => cell.id === afterId);
    if (index < 0) throw new Error(`no cell with id ${afterId}`);
    return index + 1;
  }
  if (beforeId) {
    const index = nb.cells.findIndex((cell) => cell.id === beforeId);
    if (index < 0) throw new Error(`no cell with id ${beforeId}`);
    return index;
  }
  return nb.cells.length;
}

function getKernel(session, packageRoot, requestedPython) {
  if (session.kernel?.alive) return session.kernel;
  const candidates = [requestedPython, process.env.DSH_JUPYTER_PYTHON, process.env.JUPYTER_PYTHON,
    path.join(packageRoot, '.venv', 'Scripts', 'python.exe'), path.join(packageRoot, '.venv', 'bin', 'python')].filter(Boolean);
  const python = candidates[0];
  if (!python) throw new Error('Python interpreter not configured; set DSH_JUPYTER_PYTHON');
  session.kernel = new NotebookKernel({ python, cwd: path.dirname(session.path), env: { DSH_JUPYTER_NOTEBOOK: session.path } });
  kernelsByPath.set(session.path, session.kernel);
  return session.kernel;
}

export async function panelCall(method, args = {}, options = {}) {
  const root = path.resolve(options.root || ROOT);
  const rootInfo = await fs.lstat(root).catch(() => null);
  if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('configured notebook root must be an existing real directory');
  const packageRoot = options.packageRoot || path.resolve(HERE, '..');
  const safePath = (value) => resolveSafePath(value, root);
  if (method === 'interrupt') {
    const filePath = await safePath(args.path);
    const kernel = sessions.get(filePath)?.kernel ?? kernelsByPath.get(filePath);
    if (!kernel?.alive) return { message: 'No running kernel' };
    await kernel.interrupt();
    return { message: 'Interrupt requested' };
  }
  if (method === 'list_notebooks') {
    const directory = await safePath(args.path || '.');
    return serialize(directory, async () => {
      const stat = await fs.stat(directory).catch(() => null);
      if (!stat?.isDirectory()) throw new Error('notebook folder not found');
      const entries = await fs.readdir(directory, { withFileTypes: true });
      return {
        path: label(root, directory),
        rootPath: root,
        folders: entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
          .map((entry) => ({ name: entry.name, path: label(root, path.join(directory, entry.name)) })).sort((a, b) => a.name.localeCompare(b.name)),
        notebooks: entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.ipynb'))
          .map((entry) => ({ name: entry.name, path: label(root, path.join(directory, entry.name)) })).sort((a, b) => a.name.localeCompare(b.name)),
      };
    });
  }
  if (!['open_notebook', 'read_notebook', 'save_cell', 'insert_cell', 'delete_cell', 'set_cell_type', 'move_cell', 'clear_outputs', 'run_cell', 'run_all', 'restart', 'stop_kernel', 'rename_notebook', 'delete_notebook'].includes(method)) throw new Error(`unsupported panel operation: ${method}`);
  const filePath = await safePath(args.path);
  if (method === 'open_notebook') {
    return serialize(filePath, async () => {
      if (args.create) {
        const parent = path.dirname(filePath);
        await safePath(label(root, parent));
        await fs.mkdir(parent, { recursive: true });
        const existing = await fs.lstat(filePath).catch(() => null);
        if (!existing) await writeNotebook(filePath, emptyNotebook());
        else if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('notebook path must be a regular file');
      }
      return performPanelCall(method, args, { root, packageRoot, python: options.python, onEvent: options.onEvent });
    });
  }
  return serialize(filePath, async () => {
    const activeKernel = sessions.get(filePath)?.kernel ?? kernelsByPath.get(filePath);
    if (activeKernel?.busy) throw new Error('wait for the running cell to finish or interrupt it before editing');
    if (!['read_notebook', 'restart', 'stop_kernel'].includes(method)) await requireRevision(filePath, args.expectedNotebookRevision);
    return performPanelCall(method, args, { root, packageRoot, python: options.python, onEvent: options.onEvent });
  });
}

async function performPanelCall(method, args, options) {
  const { root, packageRoot, python } = options;
  const safePath = (value) => resolveSafePath(value, root);
  switch (method) {
    case 'open_notebook': {
      const filePath = await safePath(args.path);
      return notebookView(await load(filePath), root);
    }
    case 'read_notebook': {
      const filePath = await safePath(args.path);
      const session = await load(filePath);
      return notebookView(session, root);
    }
    case 'save_cell': {
      const filePath = await safePath(args.path);
      const session = await load(filePath);
      const cell = session.nb.cells[cellIndex(session, args.cellId)];
      if (args.expectedRevision && args.expectedRevision !== revisionOf(textOf(cell))) throw new Error('cell revision conflict; reload the notebook before saving');
      setText(cell, args.source);
      if (cell.cell_type === 'code') {
        cell.outputs = [];
        cell.execution_count = null;
      }
      await save(session);
      return notebookView(session, root);
    }
    case 'insert_cell': {
      const filePath = await safePath(args.path);
      const session = await load(filePath);
      const type = ['code', 'markdown', 'raw'].includes(args.type) ? args.type : 'code';
      const cell = newCell(type, '');
      const position = targetPosition(session.nb, args.afterId, args.beforeId);
      session.nb.cells.splice(position, 0, cell);
      ensureCellIds(session.nb);
      await save(session);
      return notebookView(session, root);
    }
    case 'delete_cell': {
      const filePath = await safePath(args.path);
      const session = await load(filePath);
      session.nb.cells.splice(cellIndex(session, args.cellId), 1);
      await save(session);
      return notebookView(session, root);
    }
    case 'set_cell_type': {
      const filePath = await safePath(args.path);
      const session = await load(filePath);
      const cell = session.nb.cells[cellIndex(session, args.cellId)];
      if (!['code', 'markdown', 'raw'].includes(args.type)) throw new Error('invalid cell type');
      cell.cell_type = args.type;
      if (cell.cell_type === 'code') {
        cell.outputs = cell.outputs ?? [];
        cell.execution_count = cell.execution_count ?? null;
      } else {
        delete cell.outputs;
        delete cell.execution_count;
      }
      await save(session);
      return notebookView(session, root);
    }
    case 'move_cell': {
      const filePath = await safePath(args.path);
      const session = await load(filePath);
      const from = cellIndex(session, args.cellId);
      const to = args.direction === 'up' ? from - 1 : args.direction === 'down' ? from + 1 : from;
      if (to < 0 || to >= session.nb.cells.length) return notebookView(session, root);
      const [cell] = session.nb.cells.splice(from, 1);
      session.nb.cells.splice(to, 0, cell);
      await save(session);
      return notebookView(session, root);
    }
    case 'clear_outputs': {
      const filePath = await safePath(args.path);
      const session = await load(filePath);
      const cells = args.cellId ? [session.nb.cells[cellIndex(session, args.cellId)]] : session.nb.cells;
      for (const cell of cells) {
        if (cell.cell_type !== 'code') continue;
        cell.outputs = [];
        cell.execution_count = null;
      }
      await save(session);
      return notebookView(session, root);
    }
    case 'stop_kernel': {
      const filePath = await safePath(args.path);
      const session = sessions.get(filePath);
      await session?.kernel?.dispose().catch(() => {});
      if (session) session.kernel = null;
      kernelsByPath.delete(filePath);
      return { message: 'Kernel stopped', notebook: session ? notebookView(session, root) : null };
    }
    case 'rename_notebook': {
      const from = await safePath(args.path);
      const to = await safePath(args.newPath);
      if (!to.toLowerCase().endsWith('.ipynb')) throw new Error('a notebook name must end with .ipynb');
      if (from === to) return notebookView(await load(from), root);
      const existing = await fs.lstat(to).catch(() => null);
      if (existing) throw new Error('a file already exists at the new name');
      const session = sessions.get(from);
      // A kernel runs with its notebook's directory as cwd; moving the file to
      // another directory leaves that cwd meaningless, so drop the kernel
      // rather than let it write relative paths from the old place. Only after
      // the rename succeeded, so a failed move keeps the kernel.
      const crossDirectory = path.dirname(from) !== path.dirname(to);
      await fs.rename(from, to);
      if (session?.kernel?.alive && crossDirectory) {
        await session.kernel.dispose().catch(() => {});
        session.kernel = null;
        kernelsByPath.delete(from);
      }
      if (session) {
        sessions.delete(from);
        session.path = to;
        session.mtimeMs = (await fs.stat(to)).mtimeMs;
        sessions.set(to, session);
        const kernel = kernelsByPath.get(from);
        if (kernel) {
          kernelsByPath.delete(from);
          kernelsByPath.set(to, kernel);
        }
      } else {
        kernelsByPath.delete(from);
      }
      return notebookView(await load(to), root);
    }
    case 'delete_notebook': {
      const filePath = await safePath(args.path);
      const session = sessions.get(filePath);
      await session?.kernel?.dispose().catch(() => {});
      sessions.delete(filePath);
      kernelsByPath.delete(filePath);
      await fs.rm(filePath, { force: false });
      return { message: 'Notebook deleted', path: label(root, filePath) };
    }
    case 'run_cell':
    case 'run_all': {
      const filePath = await safePath(args.path);
      const session = await load(filePath);
      const selected = method === 'run_all' ? session.nb.cells.map((_, index) => index).filter((index) => session.nb.cells[index].cell_type === 'code')
        : [cellIndex(session, args.cellId)];
      if (selected.some((index) => session.nb.cells[index].cell_type !== 'code')) throw new Error('only code cells can be executed');
      const dirtyInput = args.dirty && typeof args.dirty === 'object' && !Array.isArray(args.dirty) ? args.dirty : {};
      const dirty = { ...dirtyInput };
      if (method === 'run_cell' && args.source !== undefined) dirty[args.cellId] = String(args.source ?? '');
      for (const [cellId, source] of Object.entries(dirty)) {
        const cell = session.nb.cells[cellIndex(session, cellId)];
        setText(cell, String(source ?? ''));
        if (cell.cell_type === 'code') {
          cell.outputs = [];
          cell.execution_count = null;
        }
      }
      if (Object.keys(dirty).length) await save(session);
      const kernel = getKernel(session, packageRoot, options.python);
      await kernel.start();
      const emit = typeof options.onEvent === 'function' ? options.onEvent : null;
      const results = [];
      for (const index of selected) {
        const cell = session.nb.cells[index];
        const source = method === 'run_cell' && args.source !== undefined ? String(args.source) : textOf(cell);
        if (emit) emit({ type: 'cell-start', cellId: cell.id, index: cell.index });
        const result = await kernel.execute(source, {
          silent: false,
          onEvent: emit ? (output) => emit({ type: 'output', cellId: cell.id, output: viewOutput(output) }) : undefined,
        });
        cell.outputs = result.outputs;
        cell.execution_count = result.executionCount ?? null;
        await save(session);
        results.push({ cellId: cell.id, status: result.status, durationMs: result.durationMs });
        if (emit) emit({ type: 'cell-done', cellId: cell.id, status: result.status, executionCount: cell.execution_count, outputs: viewOutputs(result.outputs) });
        if (result.status === 'error' || result.status === 'interrupted') break;
      }
      return { ...notebookView(session, root), run: results };
    }
    case 'restart': {
      const filePath = await safePath(args.path);
      const existing = sessions.get(filePath);
      await existing?.kernel?.dispose().catch(() => {});
      if (existing) existing.kernel = null;
      kernelsByPath.delete(filePath);
      const session = await load(filePath);
      return { message: 'Kernel restarted', notebook: notebookView(session, root) };
    }
    default:
      throw new Error(`unsupported panel operation: ${method}`);
  }
}

export async function disposePanelSessions() {
  const kernels = [...new Set([...sessions.values()].map((session) => session.kernel).concat([...kernelsByPath.values()]))].filter(Boolean);
  sessions.clear();
  kernelsByPath.clear();
  await Promise.all(kernels.map((kernel) => kernel.dispose().catch(() => {})));
}
