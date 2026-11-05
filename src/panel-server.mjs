// Panel operations for notebooks that live on a running Jupyter Server.
//
// The local panel backend (./panel-service.mjs) reads files from disk and runs
// its own Python process. This module talks to a server the user already has
// open — the same one JupyterLab uses — through the REST contents API and the
// kernel WebSocket, and reuses the kernel JupyterLab opened for a notebook so
// both sides share one namespace.

import { createHash } from 'node:crypto';
import { discoverServers, JupyterServerClient, ServerKernel } from './jupyter-server.mjs';
import { emptyNotebook, ensureCellIds, newCell, notebookRevision, revisionOf, setText, textOf } from './notebook.mjs';
import { viewCells, viewOutput, viewOutputs } from './notebook-view.mjs';

const clients = new Map(); // base url -> JupyterServerClient
const sessions = new Map(); // `${base}\u0000${path}` -> session
const locks = new Map(); // `${base}\u0000${path}` -> pending promise
const CELL_TYPES = ['code', 'markdown', 'raw'];

function sessionKey(base, notebookPath) {
  return `${base}\u0000${notebookPath}`;
}

/** Reject anything that could address a file outside the server's root. */
function safeServerPath(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/');
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new Error('server paths are relative to the Jupyter root');
  const parts = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error('path is outside the Jupyter root');
    parts.push(part);
  }
  return parts.join('/');
}

/** Directory part of a server-relative path (`''` at the root). */
function serverDirOf(value) {
  return String(value ?? '').split('/').slice(0, -1).join('/');
}

function isLoopback(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

function serialize(key, operation) {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  const tracked = current.finally(() => {
    if (locks.get(key) === tracked) locks.delete(key);
  });
  locks.set(key, tracked);
  return tracked;
}

/**
 * A discovered local server is trusted for its runtime token; a user-supplied
 * token authorises any http(s) server (the panel route itself already rejects
 * cross-site callers); everything else must be loopback.
 */
async function clientFor(url, token) {
  const requested = String(url ?? '').trim();
  if (!requested) throw new Error('a Jupyter server url is required');
  const discovered = await discoverServers({ probe: false }).catch(() => []);
  const trimmed = requested.replace(/\/+$/, '');
  const match = discovered.find((server) => server.url.replace(/\/+$/, '') === trimmed)
    ?? discovered.find((server) => server.url === requested);
  if (!match) {
    const protocol = (() => {
      try {
        return new URL(/^https?:\/\//i.test(requested) ? requested : `http://${requested}`).protocol;
      } catch {
        return '';
      }
    })();
    if (protocol !== 'http:' && protocol !== 'https:') throw new Error('a Jupyter server url must be an http(s) url');
    if (!isLoopback(requested) && !String(token ?? '').trim()) {
      throw new Error('a non-local Jupyter server needs its token');
    }
  }
  const base = match?.url ?? JupyterServerClient.fromInput(requested).base;
  const existing = clients.get(base);
  if (existing) {
    if (token && !existing.token) existing.token = String(token);
    return existing;
  }
  const client = match
    ? new JupyterServerClient({ base: match.url, token: match.token || token || '', name: match.rootDir })
    : JupyterServerClient.fromInput(requested, token);
  clients.set(client.base, client);
  return client;
}

function notebookView(client, session) {
  return {
    path: session.notebookPath,
    revision: session.revision,
    cells: viewCells(session.nb.cells),
    kernel: session.kernel?.alive ? session.kernel.describe() : null,
    sessionId: createHash('sha1').update(`${client.base}${session.notebookPath}`).digest('hex').slice(0, 10),
    target: 'server',
    server: client.base,
  };
}

function cellIndex(session, id) {
  const index = session.nb.cells.findIndex((cell) => cell.id === id);
  if (index < 0) throw new Error(`no cell with id ${id}`);
  return index;
}

function adopt(session, body) {
  session.nb = body.content;
  ensureCellIds(session.nb);
  session.revision = notebookRevision(session.nb);
  session.lastTouched = Date.now();
}

async function loadSession(client, notebookPath, { create = false } = {}) {
  const key = sessionKey(client.base, notebookPath);
  let session = sessions.get(key);
  let body = await client.readNotebook(notebookPath);
  if (!body) {
    if (!create) throw new Error(`notebook not found on the server: ${notebookPath}`);
    await client.saveNotebook(notebookPath, emptyNotebook());
    body = await client.readNotebook(notebookPath);
    if (!body) throw new Error(`could not create ${notebookPath} on the server`);
  }
  if (!body.content || typeof body.content !== 'object' || !Array.isArray(body.content.cells)) {
    throw new Error('the server returned an invalid notebook');
  }
  if (!session) {
    session = { client, notebookPath, kernel: null, lastTouched: Date.now() };
    sessions.set(key, session);
  }
  if (session.nb && session.revision === notebookRevision(body.content)) {
    session.lastTouched = Date.now();
    return session;
  }
  if (session.kernel?.busy) throw new Error('notebook changed on the server while its kernel was busy; wait or interrupt before reloading');
  adopt(session, body);
  return session;
}

async function saveSession(session) {
  await session.client.saveNotebook(session.notebookPath, session.nb);
  session.revision = notebookRevision(session.nb);
  session.lastTouched = Date.now();
}

function kernelFor(session, kernelName) {
  if (session.kernel?.alive) return session.kernel;
  session.kernel = new ServerKernel(session.client, { notebookPath: session.notebookPath, kernelSpec: kernelName || 'python3' });
  return session.kernel;
}

/** Drop our handle. A kernel JupyterLab owns must survive the panel. */
async function releaseKernel(session) {
  const kernel = session?.kernel;
  if (!kernel?.alive) return;
  session.kernel = null;
  if (kernel.kernelReused) return;
  await kernel.dispose().catch(() => {});
}

async function requireRevision(client, notebookPath, expectedRevision) {
  const body = await client.readNotebook(notebookPath);
  if (!body) throw new Error(`notebook not found on the server: ${notebookPath}`);
  if (expectedRevision !== undefined) {
    if (typeof expectedRevision !== 'string' || !expectedRevision) throw new Error('invalid notebook revision');
    if (expectedRevision !== notebookRevision(body.content)) throw new Error('notebook revision conflict; reload before continuing');
  }
  return body;
}

function stripToken(server) {
  return {
    url: server.url,
    pid: server.pid,
    version: server.version,
    rootDir: server.rootDir,
    alive: server.alive,
    kernels: server.kernels ?? null,
    hasToken: Boolean(server.token),
  };
}

export async function listServerTargets() {
  const servers = await discoverServers({ probe: true });
  return { servers: servers.filter((server) => server.alive).map(stripToken) };
}

export async function serverCall(method, args = {}, options = {}) {
  const client = await clientFor(args.server, args.token);
  const notebookPath = safeServerPath(args.path);

  if (method === 'list_notebooks') {
    const body = await client.listContents(notebookPath);
    const entries = Array.isArray(body.content) ? body.content : [];
    return {
      path: notebookPath,
      rootPath: client.base,
      target: 'server',
      server: client.base,
      folders: entries.filter((entry) => entry.type === 'directory' && !entry.name.startsWith('.'))
        .map((entry) => ({ name: entry.name, path: entry.path })).sort((a, b) => a.name.localeCompare(b.name)),
      notebooks: entries.filter((entry) => entry.type === 'notebook')
        .map((entry) => ({ name: entry.name, path: entry.path })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  if (method === 'list_kernelspecs') {
    const specs = await client.kernelspecs();
    return { kernelspecs: specs };
  }

  if (method === 'interrupt') {
    const session = sessions.get(sessionKey(client.base, notebookPath));
    const kernel = session?.kernel;
    if (!kernel?.alive) return { message: 'No running kernel' };
    await kernel.interrupt();
    return { message: 'Interrupt requested' };
  }

  if (method === 'stop_kernel') {
    const session = sessions.get(sessionKey(client.base, notebookPath));
    if (!session) return { message: 'No running kernel', notebook: null };
    await releaseKernel(session);
    return { message: 'Kernel stopped', notebook: notebookView(client, session) };
  }

  if (method === 'delete_notebook') {
    await requireRevision(client, notebookPath, args.expectedNotebookRevision);
    const session = sessions.get(sessionKey(client.base, notebookPath));
    await releaseKernel(session).catch(() => {});
    sessions.delete(sessionKey(client.base, notebookPath));
    await client.deleteNotebook(notebookPath);
    return { message: 'Notebook deleted', path: notebookPath };
  }

  if (method === 'rename_notebook') {
    const target = safeServerPath(args.newPath);
    if (!target.toLowerCase().endsWith('.ipynb')) throw new Error('a notebook name must end with .ipynb');
    if (!target) throw new Error('a new name is required');
    if (target !== notebookPath) {
      await requireRevision(client, notebookPath, args.expectedNotebookRevision);
      await client.renameNotebook(notebookPath, target);
      const from = sessionKey(client.base, notebookPath);
      const session = sessions.get(from);
      if (session) {
        // A move into another directory leaves the kernel's working directory
        // behind; drop our handle after the move succeeded (a kernel JupyterLab
        // owns survives anyway).
        if (session.kernel?.alive && serverDirOf(notebookPath) !== serverDirOf(target)) await releaseKernel(session);
        sessions.delete(from);
        session.notebookPath = target;
        sessions.set(sessionKey(client.base, target), session);
      }
    }
    const session = sessions.get(sessionKey(client.base, target)) ?? await loadSession(client, target);
    return notebookView(client, session);
  }

  if (!['open_notebook', 'read_notebook', 'save_cell', 'insert_cell', 'delete_cell', 'set_cell_type', 'move_cell', 'clear_outputs', 'run_cell', 'run_all', 'restart'].includes(method)) {
    throw new Error(`unsupported panel operation: ${method}`);
  }

  return serialize(sessionKey(client.base, notebookPath), async () => {
    const session = await loadSession(client, notebookPath, { create: method === 'open_notebook' && Boolean(args.create) });
    if (session.kernel?.busy) throw new Error('wait for the running cell to finish or interrupt it before editing');
    if (method === 'open_notebook' || method === 'read_notebook') return notebookView(client, session);
    if (method !== 'restart') {
      // Adopt exactly what the server holds so a stale tab cannot resurrect an
      // older revision on save.
      adopt(session, await requireRevision(client, notebookPath, args.expectedNotebookRevision));
    }
    switch (method) {
      case 'save_cell': {
        const cell = session.nb.cells[cellIndex(session, args.cellId)];
        if (args.expectedRevision && args.expectedRevision !== revisionOf(textOf(cell))) throw new Error('cell revision conflict; reload the notebook before saving');
        setText(cell, args.source);
        if (cell.cell_type === 'code') {
          cell.outputs = [];
          cell.execution_count = null;
        }
        await saveSession(session);
        return notebookView(client, session);
      }
      case 'insert_cell': {
        const type = CELL_TYPES.includes(args.type) ? args.type : 'code';
        let position = session.nb.cells.length;
        if (args.afterId) position = cellIndex(session, args.afterId) + 1;
        else if (args.beforeId) position = cellIndex(session, args.beforeId);
        session.nb.cells.splice(position, 0, newCell(type, ''));
        ensureCellIds(session.nb);
        await saveSession(session);
        return notebookView(client, session);
      }
      case 'delete_cell': {
        session.nb.cells.splice(cellIndex(session, args.cellId), 1);
        await saveSession(session);
        return notebookView(client, session);
      }
      case 'set_cell_type': {
        const cell = session.nb.cells[cellIndex(session, args.cellId)];
        if (!CELL_TYPES.includes(args.type)) throw new Error('invalid cell type');
        cell.cell_type = args.type;
        if (cell.cell_type === 'code') {
          cell.outputs = cell.outputs ?? [];
          cell.execution_count = cell.execution_count ?? null;
        } else {
          delete cell.outputs;
          delete cell.execution_count;
        }
        await saveSession(session);
        return notebookView(client, session);
      }
      case 'move_cell': {
        const from = cellIndex(session, args.cellId);
        const to = args.direction === 'up' ? from - 1 : args.direction === 'down' ? from + 1 : from;
        if (to < 0 || to >= session.nb.cells.length) return notebookView(client, session);
        const [cell] = session.nb.cells.splice(from, 1);
        session.nb.cells.splice(to, 0, cell);
        await saveSession(session);
        return notebookView(client, session);
      }
      case 'clear_outputs': {
        const cells = args.cellId ? [session.nb.cells[cellIndex(session, args.cellId)]] : session.nb.cells;
        for (const cell of cells) {
          if (cell.cell_type !== 'code') continue;
          cell.outputs = [];
          cell.execution_count = null;
        }
        await saveSession(session);
        return notebookView(client, session);
      }
      case 'run_cell':
      case 'run_all': {
        const selected = method === 'run_all'
          ? session.nb.cells.map((_, index) => index).filter((index) => session.nb.cells[index].cell_type === 'code')
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
        if (Object.keys(dirty).length) await saveSession(session);
        const kernel = kernelFor(session, args.kernelName);
        await kernel.start();
        const emit = typeof options.onEvent === 'function' ? options.onEvent : null;
        const results = [];
        for (const index of selected) {
          const cell = session.nb.cells[index];
          const source = method === 'run_cell' && args.source !== undefined ? String(args.source) : textOf(cell);
          if (emit) emit({ type: 'cell-start', cellId: cell.id, index: cell.index });
          const result = await kernel.execute(source, {
            onOutput: emit ? (output) => emit({ type: 'output', cellId: cell.id, output: viewOutput(output) }) : undefined,
          });
          cell.outputs = result.outputs;
          cell.execution_count = result.executionCount ?? null;
          await saveSession(session);
          results.push({ cellId: cell.id, status: result.status, durationMs: result.durationMs });
          if (emit) emit({ type: 'cell-done', cellId: cell.id, status: result.status, executionCount: cell.execution_count, outputs: viewOutputs(result.outputs) });
          if (result.status === 'error' || result.status === 'interrupted') break;
        }
        return { ...notebookView(client, session), run: results };
      }
      case 'restart': {
        if (session.kernel?.alive) await session.kernel.restart();
        else await releaseKernel(session);
        return { message: 'Kernel restarted', notebook: notebookView(client, session) };
      }
      default:
        throw new Error(`unsupported panel operation: ${method}`);
    }
  });
}

export async function disposeServerSessions() {
  const all = [...sessions.values()];
  sessions.clear();
  clients.clear();
  await Promise.all(all.map((session) => releaseKernel(session).catch(() => {})));
}
