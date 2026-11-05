// DSH Jupyter notebook MCP server.
//
// Exposes notebook editing and execution tools to DeepSeek Harness over stdio.
// Tools reach the model as `mcp__jupyter__<tool>`; see skill/SKILL.md for the
// workflow the agent is taught to follow.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  emptyNotebook,
  ensureCellIds,
  findCellIndex,
  newCell,
  normalizeNotebook,
  notebookRevision,
  readNotebook,
  revisionOf,
  setText,
  summarizeCell,
  textOf,
  writeNotebook,
} from './notebook.mjs';
import { NotebookKernel } from './kernel.mjs';
import {
  discoverServers,
  JupyterServerClient,
  ServerError,
  ServerKernel,
} from './jupyter-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const VERSION = '0.2.0';
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 2_400_000;
const MAX_CELL_TEXT = 4000;
const MAX_TOTAL_TEXT = 24_000;

const sessions = new Map();
const servers = new Map(); // connection name -> JupyterServerClient
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;


function rootDir(root) {
  return path.resolve(root && root.trim() ? root : process.env.DSH_JUPYTER_ROOT || process.cwd());
}

function resolvePath(target, root) {
  if (!target || !String(target).trim()) throw new Error('path is required');
  const base = rootDir(root);
  const trimmed = String(target).trim();
  const absolute = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(base, trimmed);
  return absolute;
}

function relativeLabel(target, root) {
  const base = rootDir(root);
  const relative = path.relative(base, target);
  return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : target;
}

function truncate(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [${text.length - limit} characters truncated]`;
}

async function loadSession(filePath, { reload = false } = {}) {
  const absolute = path.resolve(filePath);
  const existing = sessions.get(absolute);
  if (existing && !reload) {
    const stat = await fs.stat(absolute).catch(() => null);
    if (stat && Math.abs(stat.mtimeMs - existing.mtimeMs) < 1) return existing;
    // the file changed underneath us: reload rather than fight the other writer
    return reloadSession(existing);
  }
  if (existing) return reloadSession(existing);

  const loaded = await readNotebook(absolute);
  const session = {
    kind: 'local',
    path: absolute,
    nb: loaded.nb,
    revision: loaded.revision,
    mtimeMs: loaded.mtimeMs,
    kernel: null,
    lastTouched: Date.now(),
  };
  sessions.set(absolute, session);
  return session;
}

async function reloadSession(session) {
  const loaded = await readNotebook(session.path);
  session.nb = loaded.nb;
  session.revision = loaded.revision;
  session.mtimeMs = loaded.mtimeMs;
  session.lastTouched = Date.now();
  return session;
}

async function saveSession(session) {
  if (session.kind === 'server') {
    const written = await session.client.saveNotebook(session.serverPath, session.nb);
    session.revision = notebookRevision(session.nb);
    session.mtimeMs = Date.parse(written?.last_modified ?? '') || 0;
    session.lastTouched = Date.now();
    return written;
  }
  const written = await writeNotebook(session.path, session.nb);
  session.revision = written.revision;
  session.mtimeMs = written.mtimeMs;
  session.lastTouched = Date.now();
  return written;
}

// ---------------------------------------------------------------------------
// Server-backed sessions
// ---------------------------------------------------------------------------

function serverFor(name) {
  if (!name) return null;
  const direct = servers.get(name);
  if (direct) return direct;
  const lowercase = [...servers.keys()].find((key) => key.toLowerCase() === String(name).toLowerCase());
  if (lowercase) return servers.get(lowercase);
  throw new Error(
    `unknown server "${name}" — known: ${[...servers.keys()].join(', ') || 'none'}. Call list_servers, then connect_server.`,
  );
}

function normalizeServerPath(target) {
  const raw = String(target ?? '').trim().replace(/\\/g, '/');
  return raw.replace(/^\/+/, '').replace(/\/+$/, '');
}

async function loadServerSession(client, serverPath) {
  const key = `server:${client.name}:${serverPath}`;
  const existing = sessions.get(key);
  const remote = await client.readNotebook(serverPath);
  if (!remote) {
    if (existing) sessions.delete(key);
    return null;
  }
  const nb = normalizeNotebook(structuredClone(remote.content ?? {}));
  const session = existing ?? {
    kind: 'server',
    key,
    client,
    serverPath,
    kernel: null,
    lastTouched: Date.now(),
  };
  session.nb = nb;
  session.path = serverPath;
  session.client = client;
  session.revision = notebookRevision(nb);
  session.remoteLastModified = remote.last_modified ?? null;
  session.lastTouched = Date.now();
  sessions.set(key, session);
  return session;
}

async function openSession({ path: target, root, server, reload = false }) {
  if (server) {
    const client = serverFor(server);
    const serverPath = normalizeServerPath(target);
    const session = await loadServerSession(client, serverPath);
    if (!session) {
      throw new Error(`notebook not found on ${client.name}: ${serverPath} (pass create: true to open_notebook to create it)`);
    }
    return session;
  }
  return loadSession(resolvePath(target, root), { reload });
}

function sessionLabel(session, root) {
  if (session.kind === 'server') return `${session.client.name}:${session.serverPath}`;
  return relativeLabel(session.path, root);
}

function sessionKernel(session, python, packageRoot = HERE) {
  if (session.kernel && session.kernel.alive) return session.kernel;
  if (session.kind === 'server') {
    const kernel = new ServerKernel(session.client, { notebookPath: session.serverPath });
    session.kernel = kernel;
    return kernel;
  }
  const kernel = new NotebookKernel({
    python: pythonPath(python, packageRoot),
    cwd: path.dirname(session.path),
    env: { DSH_JUPYTER_NOTEBOOK: session.path },
  });
  session.kernel = kernel;
  return kernel;
}

function pythonPath(requested, packageRoot = HERE) {
  const candidates = [
    requested,
    process.env.DSH_JUPYTER_PYTHON,
    process.env.JUPYTER_PYTHON,
    path.join(packageRoot, '.venv', 'Scripts', 'python.exe'),
    path.join(packageRoot, '.venv', 'bin', 'python'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  throw new Error('no Python interpreter configured (set DSH_JUPYTER_PYTHON or create .venv in the plugin directory)');
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function cellLabel(cell, index) {
  return `[${index}] ${cell.cell_type} id=${cell.id} rev=${revisionOf(textOf(cell))}`;
}

function renderCellList(nb) {
  return nb.cells.map((cell, index) => {
    const summary = summarizeCell(cell, index);
    const badge = summary.hasError
      ? ' error'
      : summary.executionCount != null
        ? ` out[${summary.executionCount}]`
        : '';
    return `${cellLabel(cell, index)}${badge} — ${summary.preview || '(empty)'}`;
  }).join('\n');
}

function renderOutputs(cell) {
  const parts = [];
  for (const output of cell.outputs ?? []) {
    if (output.output_type === 'stream') {
      const text = truncate(output.text, MAX_CELL_TEXT).trimEnd();
      if (text) parts.push(`  ${output.name === 'stderr' ? 'stderr' : 'stdout'}: ${text.split('\n').map((line) => `| ${line}`).join('\n')}`);
      continue;
    }
    if (output.output_type === 'error') {
      const tail = (output.traceback ?? [])
        .filter(Boolean)
        .filter((line) => !/IPython[\\/]core[\\/]interactiveshell\.py/.test(line))
        .slice(-6)
        .join('\n');
      parts.push(`  error: ${output.ename}: ${output.evalue}${tail ? `\n${tail.split('\n').map((line) => `  | ${line}`).join('\n')}` : ''}`);
      continue;
    }
    const data = output.data ?? {};
    if (data['image/png']) {
      parts.push('  result: [figure]');
      continue;
    }
    if (typeof data['text/markdown'] === 'string' && data['text/markdown'].trim()) {
      parts.push(`  result (markdown):\n${truncate(data['text/markdown'], MAX_CELL_TEXT).split('\n').map((line) => `  ${line}`).join('\n')}`);
    } else if (typeof data['text/plain'] === 'string' && data['text/plain'].trim()) {
      parts.push(`  result: ${truncate(data['text/plain'], MAX_CELL_TEXT).split('\n').map((line) => `| ${line}`).join('\n')}`);
    }
  }
  return parts.join('\n');
}

function collectImages(cells, notebookPath) {
  const images = [];
  for (const cell of cells) {
    for (const [outputIndex, output] of (cell.outputs ?? []).entries()) {
      const png = output?.data?.['image/png'];
      if (typeof png !== 'string' || !png) continue;
      images.push({ cellId: cell.id, outputIndex, png });
    }
  }
  return images;
}

async function persistImages(session, images, root) {
  if (!images.length) return [];
  const directory = session.kind === 'server'
    ? path.join(rootDir(root), '.dsh-jupyter', 'figures')
    : path.join(path.dirname(session.path), '.dsh-jupyter', 'figures');
  try {
    await fs.mkdir(directory, { recursive: true });
  } catch {
    return [];
  }
  const stem = path.basename(session.path, path.extname(session.path));
  const saved = [];
  for (const image of images) {
    const name = `${stem}-${image.cellId}-${image.outputIndex + 1}.png`;
    const target = path.join(directory, name);
    try {
      await fs.writeFile(target, Buffer.from(image.png, 'base64'));
      saved.push(target);
    } catch {
      /* keep the inline image even when the workspace is read-only */
    }
  }
  return saved;
}

function imageContent(images) {
  const blocks = [];
  let budget = 0;
  for (const image of images) {
    const size = Math.ceil((image.png.length * 3) / 4);
    if (blocks.length >= MAX_IMAGES || budget + size > MAX_IMAGE_BYTES) break;
    budget += size;
    blocks.push({ type: 'image', data: image.png, mimeType: 'image/png' });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 250;

async function listNotebooks({ path: subpath, root, server }) {
  if (server) {
    const client = serverFor(server);
    const directory = normalizeServerPath(subpath ?? '').replace(/\/+$/, '');
    const listing = await client.listContents(directory);
    const entries = Array.isArray(listing.content) ? listing.content : [];
    const folders = entries.filter((entry) => entry.type === 'directory').map((entry) => `${entry.name}/`).sort();
    const notebooks = entries
      .filter((entry) => entry.type === 'notebook')
      .sort((a, b) => a.name.localeCompare(b.name));
    const lines = [`server: ${client.name} (${client.base})`, `directory: /${listing.path ?? directory}`];
    if (folders.length) lines.push(`folders: ${folders.slice(0, 40).join('  ')}${folders.length > 40 ? ' …' : ''}`);
    if (!notebooks.length) {
      lines.push('notebooks: (none) — create one with open_notebook and create=true');
      return lines.join('\n');
    }
    lines.push(`notebooks (${notebooks.length}):`);
    for (const notebook of notebooks.slice(0, MAX_ENTRIES)) {
      lines.push(`  ${notebook.path}  ${Math.round((notebook.size ?? 0) / 1024)} KB  ${notebook.last_modified ?? ''}`);
    }
    return lines.join('\n');
  }

  const target = resolvePath(subpath ?? '.', root);
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) throw new Error(`no such directory: ${target}`);
  const directory = stat.isDirectory() ? target : path.dirname(target);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const notebooks = [];
  const folders = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      folders.push(`${entry.name}/`);
      continue;
    }
    if (!entry.name.endsWith('.ipynb')) continue;
    const info = await fs.stat(full).catch(() => null);
    notebooks.push({
      name: entry.name,
      path: relativeLabel(full, root),
      sizeBytes: info?.size ?? 0,
      modified: info ? new Date(info.mtimeMs).toISOString() : null,
    });
  }
  folders.sort();
  notebooks.sort((a, b) => a.name.localeCompare(b.name));
  const lines = [`directory: ${relativeLabel(directory, root)}`];
  if (folders.length) lines.push(`folders: ${folders.slice(0, 40).join('  ')}${folders.length > 40 ? ' …' : ''}`);
  if (!notebooks.length) {
    lines.push('notebooks: (none) — create one with open_notebook and create=true');
    return lines.join('\n');
  }
  lines.push(`notebooks (${notebooks.length}):`);
  for (const notebook of notebooks.slice(0, MAX_ENTRIES)) {
    lines.push(`  ${notebook.path}  ${Math.round(notebook.sizeBytes / 1024)} KB  ${notebook.modified}`);
  }
  return lines.join('\n');
}

async function openNotebook({ path: target, create, root, server }) {
  if (server) {
    const client = serverFor(server);
    const serverPath = normalizeServerPath(target);
    let created = false;
    let remote = await client.readNotebook(serverPath);
    if (!remote) {
      if (!create) {
        throw new Error(`notebook not found on ${client.name}: ${serverPath} (pass create: true to create it)`);
      }
      await client.saveNotebook(serverPath, emptyNotebook());
      created = true;
      remote = await client.readNotebook(serverPath);
    }
    const session = await loadServerSession(client, serverPath);
    return [
      `${created ? 'created' : 'opened'} ${client.name}:${serverPath}`,
      `revision: ${session.revision}`,
      `cells (${session.nb.cells.length}):`,
      session.nb.cells.length ? renderCellList(session.nb) : '  (empty notebook)',
    ].join('\n');
  }

  const filePath = resolvePath(target, root);
  const existing = await fs.stat(filePath).catch(() => null);
  let created = false;
  if (!existing) {
    if (!create) {
      throw new Error(`notebook not found: ${relativeLabel(filePath, root)} (pass create: true to create it)`);
    }
    const nb = emptyNotebook();
    await writeNotebook(filePath, nb);
    created = true;
  }
  const session = await loadSession(filePath, { reload: true });
  return [
    `${created ? 'created' : 'opened'} ${relativeLabel(session.path, root)}`,
    `revision: ${session.revision}`,
    `cells (${session.nb.cells.length}):`,
    session.nb.cells.length ? renderCellList(session.nb) : '  (empty notebook)',
  ].join('\n');
}

async function readNotebookTool({ path: target, cellIds, includeOutputs = true, includeImages = false, root, server }) {
  const session = await openSession({ path: target, root, server });
  const nb = session.nb;
  let selection;
  if (cellIds?.length) {
    selection = cellIds.map((cellId) => {
      const index = findCellIndex(nb, cellId);
      if (index < 0) throw new Error(`no cell with id ${cellId}`);
      return { cellId, index, cell: nb.cells[index] };
    });
  } else {
    selection = nb.cells.map((cell, index) => ({ cellId: cell.id, index, cell }));
  }
  const chunks = [];
  let used = 0;
  for (const { index, cell } of selection) {
    const header = `${cellLabel(cell, index)}${cell.cell_type === 'code' && cell.execution_count != null ? ` out[${cell.execution_count}]` : ''}`;
    const body = textOf(cell) || '(empty)';
    let chunk = `${header}\n${truncate(body, MAX_CELL_TEXT)}`;
    if (includeOutputs && cell.cell_type === 'code' && (cell.outputs ?? []).length) {
      const rendered = renderOutputs(cell);
      if (rendered) chunk += `\n  outputs:\n${rendered}`;
    }
    if (used + chunk.length > MAX_TOTAL_TEXT) {
      chunks.push(`… ${selection.length - chunks.length} more cells omitted; pass cellIds to read them`);
      break;
    }
    used += chunk.length;
    chunks.push(chunk);
  }
  const images = includeImages ? collectImages(selection.map((entry) => entry.cell), session.path) : [];
  const saved = images.length ? await persistImages(session, images, root) : [];
  const footer = saved.length ? `\n\nfigures on disk:\n${saved.map((file) => `  ${file}`).join('\n')}` : '';
  return { text: `notebook: ${sessionLabel(session, root)}\nrevision: ${session.revision}\n\n${chunks.join('\n\n')}${footer}`, images };
}

function applyOperation(nb, operation) {
  const type = operation.op;
  const requireCell = () => {
    const index = findCellIndex(nb, operation.cellId);
    if (index < 0) throw new Error(`no cell with id ${operation.cellId}`);
    return index;
  };
  const targetIndex = () => {
    if (operation.after) {
      const index = findCellIndex(nb, operation.after);
      if (index < 0) throw new Error(`no cell with id ${operation.after}`);
      return index + 1;
    }
    if (operation.before) {
      const index = findCellIndex(nb, operation.before);
      if (index < 0) throw new Error(`no cell with id ${operation.before}`);
      return index;
    }
    if (typeof operation.index === 'number') return Math.max(0, Math.min(nb.cells.length, operation.index));
    return nb.cells.length;
  };

  switch (type) {
    case 'insert': {
      const cellType = operation.type ?? 'code';
      if (!['code', 'markdown', 'raw'].includes(cellType)) throw new Error(`invalid cell type ${cellType}`);
      const cell = newCell(cellType, operation.source ?? '');
      const at = targetIndex();
      nb.cells.splice(at, 0, cell);
      ensureCellIds(nb);
      return `inserted ${cellType} cell id=${cell.id} at index ${at}`;
    }
    case 'update': {
      const index = requireCell();
      const cell = nb.cells[index];
      const expected = operation.expectedRevision;
      if (expected && expected !== revisionOf(textOf(cell))) {
        throw new Error(`revision_conflict: cell ${cell.id} is ${revisionOf(textOf(cell))}, expected ${expected}; read_notebook first`);
      }
      setText(cell, operation.source ?? '');
      return `updated cell id=${cell.id} rev=${revisionOf(textOf(cell))}`;
    }
    case 'move': {
      const index = requireCell();
      const [cell] = nb.cells.splice(index, 1);
      const at = targetIndex();
      nb.cells.splice(at > index ? at - 1 : at, 0, cell);
      return `moved cell id=${cell.id} to index ${at > index ? at - 1 : at}`;
    }
    case 'delete': {
      const index = requireCell();
      const [cell] = nb.cells.splice(index, 1);
      return `deleted cell id=${cell.id}`;
    }
    case 'set_type': {
      const index = requireCell();
      const cell = nb.cells[index];
      const next = operation.type;
      if (!['code', 'markdown', 'raw'].includes(next)) throw new Error(`invalid cell type ${next}`);
      if (cell.cell_type === next) return `cell id=${cell.id} is already ${next}`;
      cell.cell_type = next;
      if (next === 'code') {
        cell.outputs = cell.outputs ?? [];
        cell.execution_count = cell.execution_count ?? null;
      } else {
        delete cell.outputs;
        delete cell.execution_count;
      }
      return `cell id=${cell.id} is now ${next}`;
    }
    case 'clear_outputs': {
      const targets = operation.cellId ? [requireCell()] : nb.cells.map((_cell, index) => index);
      let cleared = 0;
      for (const index of targets) {
        const cell = nb.cells[index];
        if (cell.cell_type !== 'code') continue;
        if ((cell.outputs ?? []).length) cleared += 1;
        cell.outputs = [];
        cell.execution_count = null;
      }
      return `cleared outputs on ${cleared} cell(s)`;
    }
    default:
      throw new Error(`unknown operation: ${type}`);
  }
}

async function editNotebook({ path: target, operations, expectedRevision, dryRun = false, root, server }) {
  const session = await openSession({ path: target, root, server });
  if (expectedRevision && expectedRevision !== session.revision) {
    throw new Error(
      `revision_conflict: notebook is at ${session.revision}, expected ${expectedRevision}. Call read_notebook and redo the edit on the current content.`,
    );
  }
  const results = [];
  const touched = [];
  for (const operation of operations) {
    results.push(applyOperation(session.nb, operation));
    touched.push(operation.cellId ?? operation.after ?? operation.before ?? null);
  }
  if (dryRun) {
    return `dry run (not saved):\n${results.join('\n')}`;
  }
  await saveSession(session);
  return [
    `saved ${sessionLabel(session, root)} (revision ${session.revision})`,
    ...results,
    '',
    renderCellList(session.nb),
  ].join('\n');
}

async function executeCells({ path: target, cellIds, all, timeoutSeconds = 300, includeImages = true, stopOnError = true, root, server }) {
  const session = await openSession({ path: target, root, server });
  const nb = session.nb;
  const order = [];
  if (all || !cellIds?.length) {
    nb.cells.forEach((cell, index) => {
      if (cell.cell_type === 'code' && textOf(cell).trim()) order.push(index);
    });
  } else {
    for (const cellId of cellIds) {
      const index = findCellIndex(nb, cellId);
      if (index < 0) throw new Error(`no cell with id ${cellId}`);
      if (nb.cells[index].cell_type !== 'code') throw new Error(`cell ${cellId} is not a code cell`);
      order.push(index);
    }
  }
  if (!order.length) return 'nothing to run: the notebook has no non-empty code cells';

  const kernel = sessionKernel(session);
  await kernel.start();
  const started = Date.now();
  const deadline = started + Math.max(5, Math.min(3600, timeoutSeconds)) * 1000;
  const reports = [];
  let running = null;
  let status = 'ok';

  const executed = [];
  for (const index of order) {
    const cell = nb.cells[index];
    if (Date.now() > deadline) {
      reports.push(`${cellLabel(cell, index)} — skipped (call timeout)`);
      status = 'timeout';
      break;
    }
    const pending = kernel.execute(textOf(cell), { silent: false });
    const outcome = await Promise.race([
      pending.then((result) => ({ done: true, result })),
      new Promise((resolve) => setTimeout(() => resolve({ done: false }), Math.max(1000, deadline - Date.now()))),
    ]);
    if (!outcome.done) {
      running = { index, cell, pending, kernel };
      reports.push(`${cellLabel(cell, index)} — still running after ${timeoutSeconds}s; it keeps running in the background and its outputs land in the notebook when it finishes`);
      status = 'running';
      break;
    }
    const result = outcome.result;
    cell.outputs = result.outputs;
    cell.execution_count = result.executionCount ?? null;
    executed.push(cell);
    await saveSession(session);
    const rendered = renderOutputs(cell);
    reports.push(`${cellLabel(cell, index)} — ${result.status} in ${result.durationMs} ms${rendered ? `\n${rendered}` : ''}`);
    if (result.status === 'error' || result.status === 'interrupted') {
      status = result.status;
      if (stopOnError) {
        const skipped = order.slice(order.indexOf(index) + 1);
        if (skipped.length) reports.push(`stopped: ${skipped.length} later cell(s) not run (pass stopOnError=false to continue)`);
        break;
      }
    }
  }

  if (running) {
    // Persist the late result without holding the tool call open.
    running.pending
      .then(async (result) => {
        running.cell.outputs = result.outputs;
        running.cell.execution_count = result.executionCount ?? null;
        await saveSession(session);
      })
      .catch(() => {});
  }

  const images = includeImages ? collectImages(executed, session.path) : [];
  const saved = images.length ? await persistImages(session, images, root) : [];
  const header = `notebook: ${sessionLabel(session, root)} (revision ${session.revision})\nstatus: ${status}\n`;
  const footer = saved.length ? `\nfigures on disk:\n${saved.map((file) => `  ${file}`).join('\n')}\n(show them to the user with the present tool)` : '';
  return { text: `${header}\n${reports.join('\n\n')}${footer}`, images };
}

async function kernelStatus() {
  const lines = [];
  for (const session of sessions.values()) {
    const kernel = session.kernel;
    const where = session.kind === 'server' ? `${session.client.name}:${session.serverPath}` : session.path;
    if (kernel?.alive) {
      const info = kernel.describe();
      const running = kernel.info?.kind === 'jupyter-server'
        ? `jupyter kernel ${info.kernelId}${kernel.info.sharedWithLab ? ' (shared with JupyterLab)' : ''}`
        : `pid ${info.pid}`;
      lines.push(`${where}\n  kernel: ${running}, busy=${info.busy}\n  revision: ${session.revision}, cells: ${session.nb.cells.length}`);
    } else {
      lines.push(`${where}\n  kernel: not started\n  revision: ${session.revision}, cells: ${session.nb.cells.length}`);
    }
  }
  for (const client of servers.values()) {
    const known = [...client.kernels.keys()];
    lines.push(`server ${client.name} (${client.base}): ${known.length} kernel(s)${known.length ? ` — ${known.join(', ')}` : ''}`);
  }
  return lines.length ? lines.join('\n') : 'no notebooks open and no servers connected';
}

async function interruptKernel({ path: target, all, root, server }) {
  let targets;
  if (all || (!target && !server)) {
    targets = [...sessions.values()];
  } else if (!target) {
    const client = serverFor(server);
    targets = [...sessions.values()].filter((session) => session.kind === 'server' && session.client === client);
  } else {
    targets = [await openSession({ path: target, root, server })];
  }
  const lines = [];
  for (const session of targets) {
    const label = sessionLabel(session, root);
    if (!session.kernel?.alive) {
      lines.push(`${label}: no running kernel`);
      continue;
    }
    await session.kernel.interrupt();
    lines.push(`${label}: interrupt requested`);
  }
  return lines.join('\n') || 'no kernels to interrupt';
}

async function restartKernel({ path: target, runAll, root, server }) {
  let session;
  if (target) {
    session = await openSession({ path: target, root, server });
  } else if (server) {
    const client = serverFor(server);
    session = [...sessions.values()].reverse().find((entry) => entry.kind === 'server' && entry.client === client);
    if (!session) throw new Error(`no notebook from "${client.name}" is open yet; pass path`);
  } else {
    session = [...sessions.values()][0];
    if (!session) throw new Error('no notebook is open; pass path to restart its kernel');
  }
  const label = sessionLabel(session, root);

  if (session.kind === 'server') {
    if (session.kernel?.alive) await session.kernel.restart();
    else await sessionKernel(session).start();
    const lines = [`restarted kernel for ${label}; all variables are gone`];
    if (runAll) {
      const rerun = await executeCells({ path: session.serverPath, server: session.client.name, all: true, includeImages: false, root });
      lines.push('', rerun.text);
    }
    return lines.join('\n');
  }

  if (session.kernel) await session.kernel.dispose();
  session.kernel = null;
  const kernel = sessionKernel(session);
  await kernel.start();
  const lines = [`restarted kernel for ${label} (pid ${kernel.describe().pid}); all variables are gone`];
  if (runAll) {
    const rerun = await executeCells({ path: session.path, all: true, includeImages: false, root });
    lines.push('', rerun.text);
  }
  return lines.join('\n');
}

function toMarkdown(nb) {
  const parts = [];
  for (const cell of nb.cells) {
    const text = textOf(cell);
    if (cell.cell_type === 'markdown') {
      parts.push(text);
      continue;
    }
    if (cell.cell_type === 'raw') {
      parts.push(text);
      continue;
    }
    parts.push(`\`\`\`python\n${text}\n\`\`\``);
    for (const output of cell.outputs ?? []) {
      if (output.output_type === 'stream' && output.text?.trim()) {
        parts.push(`\`\`\`\n${output.text.trimEnd()}\n\`\`\``);
      } else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
        const data = output.data ?? {};
        if (typeof data['text/markdown'] === 'string') parts.push(data['text/markdown']);
        else if (typeof data['text/plain'] === 'string' && data['text/plain'].trim()) {
          parts.push(`\`\`\`\n${data['text/plain'].trimEnd()}\n\`\`\``);
        }
        if (data['image/png']) parts.push('_(figure: see the HTML export or the notebook itself)_');
      } else if (output.output_type === 'error') {
        parts.push(`\`\`\`\n${output.ename}: ${output.evalue}\n\`\`\``);
      }
    }
  }
  return `${parts.join('\n\n')}\n`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function toHtml(nb, title) {
  const body = nb.cells.map((cell) => {
    const text = textOf(cell);
    if (cell.cell_type === 'markdown') {
      return `<section class="md"><pre>${escapeHtml(text)}</pre></section>`;
    }
    let html = `<section class="code"><pre class="src">${escapeHtml(text)}</pre>`;
    for (const output of cell.outputs ?? []) {
      if (output.output_type === 'stream') {
        html += `<pre class="out">${escapeHtml(output.text ?? '')}</pre>`;
      } else if (output.output_type === 'error') {
        html += `<pre class="err">${escapeHtml(`${output.ename}: ${output.evalue}`)}</pre>`;
      } else {
        const data = output.data ?? {};
        if (data['image/png']) {
          html += `<img src="data:image/png;base64,${data['image/png']}" alt="figure">`;
        } else if (typeof data['text/html'] === 'string') {
          html += `<div class="rich">${data['text/html']}</div>`;
        } else if (typeof data['text/plain'] === 'string') {
          html += `<pre class="out">${escapeHtml(data['text/plain'])}</pre>`;
        }
      }
    }
    return `${html}</section>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{font:15px/1.6 -apple-system,Segoe UI,sans-serif;max-width:960px;margin:32px auto;padding:0 20px;color:#1f2328}
pre{background:#f6f8fa;padding:12px;border-radius:8px;overflow:auto}
pre.src{border-left:4px solid #4c8dff}
pre.out{background:#fff;border:1px solid #e5e7eb}
pre.err{background:#fff5f5;border:1px solid #fecaca;color:#b91c1c}
img{max-width:100%}
.md pre{background:none;padding:0;font:inherit;white-space:pre-wrap}
</style></head>
<body><h1>${escapeHtml(title)}</h1>
${body}
</body></html>
`;
}

async function exportNotebook({ path: target, format = 'markdown', output, root, server }) {
  const session = await openSession({ path: target, root, server });
  const stem = path.basename(session.path, path.extname(session.path));
  const extension = format === 'html' ? '.html' : '.md';
  const destination = output
    ? resolvePath(output, root)
    : session.kind === 'server'
      ? path.join(rootDir(root), '.dsh-jupyter', 'exports', `${stem}.export${extension}`)
      : path.join(path.dirname(session.path), `${stem}.export${extension}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const body = format === 'html' ? toHtml(session.nb, stem) : toMarkdown(session.nb);
  await fs.writeFile(destination, body, 'utf8');
  return `exported ${format} to ${destination}\n(open it with the present tool so the user can read it)`;
}

// ---------------------------------------------------------------------------
// Server connection tools
// ---------------------------------------------------------------------------

async function listServers({ probe = true } = {}) {
  const discovered = await discoverServers({ probe });
  const lines = [];
  if (discovered.length) {
    lines.push('running on this machine:');
    for (const entry of discovered) {
      const connected = [...servers.values()].find((client) => client.base === entry.url);
      lines.push(
        `  ${entry.url}  pid ${entry.pid ?? '?'}  ${entry.alive ? 'reachable' : 'NOT reachable'}` +
          `  token: ${entry.token ? 'found' : 'none'}  version ${entry.version ?? '?'}` +
          (connected ? `  [connected as "${connected.name}"]` : ''),
      );
    }
  } else {
    lines.push('no running Jupyter Server found on this machine (no live jupyter runtime files).');
  }
  if (servers.size) {
    lines.push('', 'connected:');
    for (const client of servers.values()) {
      lines.push(`  "${client.name}"  ${client.base}  token ${client.token ? 'set' : 'none'}  ${client.kernels.size} kernel(s)`);
    }
  } else {
    lines.push('', 'connected: (none)');
  }
  if (discovered.length) {
    const first = discovered.find((entry) => entry.alive) ?? discovered[0];
    lines.push('', `Connect with: connect_server { url: "${first.url}" } — a local runtime token is used automatically.`);
  } else {
    lines.push('', 'Connect a remote server with: connect_server { url: "http://host:8888/", token: "<token>" }');
  }
  return lines.join('\n');
}

async function connectServer({ url, token, name }) {
  const client = JupyterServerClient.fromInput(url, token);
  let resolvedToken = client.token;
  if (!resolvedToken) {
    const discovered = await discoverServers({ probe: false });
    const match = discovered.find((entry) => entry.url === client.base);
    if (match?.token) {
      resolvedToken = match.token;
      client.token = match.token;
    }
  }
  const status = await client.status();
  const version = await client.version();
  const host = new URL(client.base).host;
  const connectionName = String(name ?? host).trim() || host;
  const previous = servers.get(connectionName);
  if (previous && previous !== client) {
    for (const kernel of previous.kernels.values()) kernel.dispose().catch(() => {});
  }
  client.name = connectionName;
  servers.set(connectionName, client);

  const listing = await client.listContents('').catch(() => null);
  const notebooks = Array.isArray(listing?.content)
    ? listing.content.filter((entry) => entry.type === 'notebook').map((entry) => entry.name)
    : [];
  const openSessions = await client.sessions().catch(() => []);
  const lines = [
    `connected to ${client.base} as "${connectionName}"`,
    `jupyter server ${version ?? '?'}; started ${status?.started ?? '?'}; kernels ${status?.kernels ?? 0}`,
    `token: ${resolvedToken ? 'in use (kept inside the MCP server)' : 'none'}`,
  ];
  if (openSessions.length) {
    lines.push(`open sessions: ${openSessions.map((session) => `${session.path} (${session.kernel?.name ?? '?'})`).join(', ')}`);
  }
  lines.push(`top-level notebooks: ${notebooks.length ? notebooks.slice(0, 20).join(', ') : '(none)'}`);
  lines.push('', `Use it by passing server: "${connectionName}" to the notebook tools; paths are then relative to the server root.`);
  return lines.join('\n');
}

function disconnectServer({ server }) {
  const client = serverFor(server);
  for (const session of [...sessions.values()]) {
    if (session.kind === 'server' && session.client === client) sessions.delete(session.key);
  }
  servers.delete(client.name);
  return `disconnected "${client.name}" (${client.base}); kernels it started stay running unless you restart them from JupyterLab`;
}

// ---------------------------------------------------------------------------
// MCP wiring
// ---------------------------------------------------------------------------

const cellSource = z.string().describe('Complete new cell text (markdown or code as-is).');
const operationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('insert'),
    type: z.enum(['code', 'markdown', 'raw']).default('code'),
    source: cellSource,
    after: z.string().optional().describe('Insert right after this cell id.'),
    before: z.string().optional().describe('Insert right before this cell id.'),
    index: z.number().int().optional().describe('Insert at this list index (default: append).'),
  }),
  z.object({
    op: z.literal('update'),
    cellId: z.string(),
    source: cellSource,
    expectedRevision: z.string().optional().describe('Revision from a previous read; mismatches fail with revision_conflict.'),
  }),
  z.object({
    op: z.literal('move'),
    cellId: z.string(),
    after: z.string().optional(),
    before: z.string().optional(),
    index: z.number().int().optional(),
  }),
  z.object({ op: z.literal('delete'), cellId: z.string() }),
  z.object({ op: z.literal('set_type'), cellId: z.string(), type: z.enum(['code', 'markdown', 'raw']) }),
  z.object({ op: z.literal('clear_outputs'), cellId: z.string().optional().describe('Omit to clear every code cell.') }),
]);

const commonPath = {
  path: z.string().describe('Notebook path: absolute or relative to the workspace root locally, or relative to the server root when `server` is set.'),
  root: z.string().optional().describe('Workspace root for relative local paths (default: the harness working directory).'),
  server: z.string().optional().describe('Name of a connected Jupyter Server (see list_servers / connect_server). When set, the notebook lives on that server.'),
};

function text(value) {
  return { content: [{ type: 'text', text: String(value) }] };
}

function withImages(result) {
  const blocks = [{ type: 'text', text: result.text }];
  const images = imageContent(result.images ?? []);
  return { content: [...blocks, ...images] };
}

function createServer() {
const server = new McpServer({ name: 'dsh-jupyter', version: VERSION }, { capabilities: { tools: {} } });

server.registerTool(
  'list_servers',
  {
    description:
      'List Jupyter Servers running on this machine (discovered from the jupyter runtime directory) and the ones already connected. Start here when the user mentions a Jupyter Server or JupyterLab.',
    inputSchema: z.object({}),
  },
  async () => text(await listServers({})),
);

server.registerTool(
  'connect_server',
  {
    description:
      'Connect a Jupyter Server by URL (and token when it is not a local one). After connecting, pass server: "<name>" to the notebook tools to read, edit and run notebooks on it with its own kernels.',
    inputSchema: z.object({
      url: z.string().describe('Server URL, e.g. http://localhost:8888/ or https://host/user/me/ (a pasted ?token=… is used automatically).'),
      token: z.string().optional().describe('Jupyter token; omit for a local server found by list_servers (the runtime token is used).'),
      name: z.string().optional().describe('Connection name to pass as `server` later (default: host:port).'),
    }),
  },
  async (args) => text(await connectServer(args)),
);

server.registerTool(
  'disconnect_server',
  {
    description: 'Forget a connected Jupyter Server. Notebooks on it stay untouched; kernels keep running.',
    inputSchema: z.object({ server: z.string().describe('Connection name returned by connect_server.') }),
  },
  async (args) => text(disconnectServer(args)),
);

server.registerTool(
  'list_notebooks',
  {
    description: 'List folders and .ipynb notebooks in a workspace directory (or on a connected server when `server` is set). Start here when you do not know what exists.',
    inputSchema: z.object({
      path: z.string().optional().describe('Directory to list (default: workspace root / server root).'),
      root: commonPath.root,
      server: commonPath.server,
    }),
  },
  async ({ path: subpath, root, server: serverName }) => text(await listNotebooks({ path: subpath, root, server: serverName })),
);

server.registerTool(
  'open_notebook',
  {
    description:
      'Open a notebook (or create it with create=true) and list its cells as [index] type id=… rev=… . Always address cells by id afterwards.',
    inputSchema: z.object({
      ...commonPath,
      create: z.boolean().optional().describe('Create the notebook when the file does not exist.'),
    }),
  },
  async ({ path: target, create, root, server: serverName }) => text(await openNotebook({ path: target, create, root, server: serverName })),
);

server.registerTool(
  'read_notebook',
  {
    description:
      'Read cells in full, with their outputs. Call this before editing when the file may have changed since your last read.',
    inputSchema: z.object({
      ...commonPath,
      cellIds: z.array(z.string()).optional().describe('Read only these cells.'),
      includeOutputs: z.boolean().optional().describe('Include stored outputs (default true).'),
      includeImages: z.boolean().optional().describe('Attach figure outputs as images (default false).'),
    }),
  },
  async (args) => withImages(await readNotebookTool(args)),
);

server.registerTool(
  'edit_notebook',
  {
    description:
      'Apply cell operations (insert/update/move/delete/set_type/clear_outputs) and save the notebook immediately. Operations run in order; on conflict nothing is written.',
    inputSchema: z.object({
      ...commonPath,
      operations: z.array(operationSchema).min(1),
      expectedRevision: z.string().optional().describe('Notebook revision from open_notebook/read_notebook; fails on mismatch.'),
      dryRun: z.boolean().optional(),
    }),
  },
  async (args) => text(await editNotebook(args)),
);

server.registerTool(
  'execute_cells',
  {
    description:
      'Run code cells in order (or the whole notebook with all=true), store their outputs in the notebook and return them. Figures come back as images plus PNG files on disk.',
    inputSchema: z.object({
      ...commonPath,
      cellIds: z.array(z.string()).optional(),
      all: z.boolean().optional().describe('Run every non-empty code cell from the top.'),
      timeoutSeconds: z.number().int().optional().describe('Wall-clock budget for this call (default 300s; a long cell keeps running in the background).'),
      includeImages: z.boolean().optional().describe('Attach figures as images (default true).'),
      stopOnError: z.boolean().optional().describe('Stop the batch at the first failing cell (default true, like Jupyter).'),
    }),
  },
  async (args) => withImages(await executeCells(args)),
);

server.registerTool(
  'interrupt_kernel',
  {
    description: 'Interrupt the running cell. Best effort: blocking C calls may not stop until they return; restart_kernel is the hard stop.',
    inputSchema: z.object({
      path: z.string().optional().describe('Notebook whose kernel to interrupt (default: every open notebook).'),
      all: z.boolean().optional().describe('Interrupt every open kernel.'),
      root: commonPath.root,
      server: commonPath.server,
    }),
  },
  async (args) => text(await interruptKernel(args)),
);

server.registerTool(
  'restart_kernel',
  {
    description: 'Restart the notebook kernel (all variables gone), optionally re-running the whole notebook afterwards.',
    inputSchema: z.object({
      path: z.string().optional().describe('Notebook whose kernel to restart (default: the most recently opened one).'),
      runAll: z.boolean().optional().describe('Run every code cell after the restart.'),
      root: commonPath.root,
      server: commonPath.server,
    }),
  },
  async (args) => text(await restartKernel(args)),
);

server.registerTool(
  'kernel_status',
  {
    description: 'Show open notebooks, their kernel state (local pid or Jupyter kernel id), revisions, and connected servers.',
    inputSchema: z.object({}),
  },
  async () => text(await kernelStatus()),
);

server.registerTool(
  'export_notebook',
  {
    description: 'Export the notebook to Markdown or a self-contained HTML file so the user can read it in a side panel.',
    inputSchema: z.object({
      ...commonPath,
      format: z.enum(['markdown', 'html']).optional(),
      output: z.string().optional().describe('Destination file (default: <notebook>.export.md/.html).'),
    }),
  },
  async (args) => text(await exportNotebook(args)),
);

  return server;
}

serveStdio(createServer, {
  onerror: (error) => {
    process.stderr.write(`[dsh-jupyter] ${error?.stack ?? error}\n`);
  },
});

process.on('SIGTERM', async () => {
  for (const session of sessions.values()) {
    if (session.kernel) await session.kernel.dispose().catch(() => {});
  }
  process.exit(0);
});

// Keep the process from lingering on idle kernels after the client disappears.
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.lastTouched > SESSION_TTL_MS && !session.kernel?.busy) {
      session.kernel?.dispose().catch(() => {});
      sessions.delete(key);
    }
  }
}, 10 * 60 * 1000).unref();
