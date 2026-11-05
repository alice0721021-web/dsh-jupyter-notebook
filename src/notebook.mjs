// Notebook file model: nbformat 4.5 read/write, cell identity, revisions.
//
// Deliberately dependency free: the .ipynb is plain JSON and the DSH side only
// needs a stable cell identity plus a revision token for optimistic conflicts.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const NBFORMAT = 4;
export const NBFORMAT_MINOR = 5;

export function textOf(cell) {
  const source = cell?.source;
  if (Array.isArray(source)) return source.join('');
  return typeof source === 'string' ? source : '';
}

export function setText(cell, value) {
  cell.source = String(value ?? '');
}

export function revisionOf(value) {
  return createHash('sha1').update(String(value ?? ''), 'utf8').digest('hex').slice(0, 10);
}

export function notebookRevision(nb) {
  const hash = createHash('sha1');
  for (const cell of nb.cells ?? []) {
    hash.update(cell.id ?? '');
    hash.update('\u0000');
    hash.update(cell.cell_type ?? '');
    hash.update('\u0000');
    hash.update(textOf(cell));
    hash.update('\u0001');
  }
  return hash.digest('hex').slice(0, 12);
}

export function notebookFingerprint(nb) {
  return createHash('sha1').update(JSON.stringify(nb), 'utf8').digest('hex');
}

const ID_ALPHABET = '0123456789abcdef';

function newCellId(taken) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    let id = '';
    for (let index = 0; index < 8; index += 1) {
      id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    }
    if (!taken.has(id)) return id;
  }
  throw new Error('could not allocate a cell id');
}

export function ensureCellIds(nb) {
  const taken = new Set();
  for (const cell of nb.cells ?? []) {
    if (typeof cell.id === 'string' && cell.id && !taken.has(cell.id)) {
      taken.add(cell.id);
    }
  }
  for (const cell of nb.cells ?? []) {
    if (typeof cell.id !== 'string' || !cell.id || !taken.has(cell.id)) {
      cell.id = newCellId(taken);
      taken.add(cell.id);
    }
  }
  return nb;
}

export function emptyNotebook({ language = 'python', kernelName = 'python3' } = {}) {
  return {
    cells: [],
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: kernelName,
      },
      language_info: {
        name: language,
        version: '',
        mimetype: `text/x-${language}`,
        file_extension: language === 'python' ? '.py' : `.${language}`,
      },
    },
    nbformat: NBFORMAT,
    nbformat_minor: NBFORMAT_MINOR,
  };
}

export function normalizeNotebook(nb) {
  if (!nb || typeof nb !== 'object') throw new Error('notebook is not a JSON object');
  if (!Array.isArray(nb.cells)) throw new Error('notebook has no cells array');
  nb.nbformat = NBFORMAT;
  if (!Number.isFinite(nb.nbformat_minor) || nb.nbformat_minor < NBFORMAT_MINOR) {
    nb.nbformat_minor = NBFORMAT_MINOR;
  }
  nb.metadata = nb.metadata && typeof nb.metadata === 'object' ? nb.metadata : {};
  for (const cell of nb.cells) {
    if (!cell || typeof cell !== 'object') throw new Error('notebook has an invalid cell');
    if (!['code', 'markdown', 'raw'].includes(cell.cell_type)) {
      throw new Error(`unsupported cell type: ${cell.cell_type}`);
    }
    if (!cell.metadata || typeof cell.metadata !== 'object') cell.metadata = {};
    if (cell.cell_type === 'code') {
      if (!Array.isArray(cell.outputs)) cell.outputs = [];
      if (!('execution_count' in cell)) cell.execution_count = null;
    }
    setText(cell, textOf(cell));
  }
  ensureCellIds(nb);
  return nb;
}

export async function readNotebook(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) throw new Error(`notebook not found: ${filePath}`);
  if (!stat.isFile()) throw new Error(`not a file: ${filePath}`);
  const raw = await fs.readFile(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`notebook is not valid JSON: ${error.message}`);
  }
  const nb = normalizeNotebook(parsed);
  return {
    path: path.resolve(filePath),
    nb,
    revision: notebookRevision(nb),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

export async function writeNotebook(filePath, nb) {
  normalizeNotebook(nb);
  const body = `${JSON.stringify(nb, null, 1)}\n`;
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temp, body, 'utf8');
  await fs.rename(temp, filePath);
  const stat = await fs.stat(filePath);
  return { revision: notebookRevision(nb), mtimeMs: stat.mtimeMs, size: stat.size };
}

export function findCellIndex(nb, cellId) {
  return (nb.cells ?? []).findIndex((cell) => cell.id === cellId);
}

export function summarizeCell(cell, index) {
  const text = textOf(cell);
  const firstLine = text.split('\n').find((line) => line.trim()) ?? '';
  return {
    index,
    id: cell.id,
    type: cell.cell_type,
    rev: revisionOf(text),
    lines: text ? text.split('\n').length : 0,
    chars: text.length,
    preview: firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine,
    executionCount: cell.cell_type === 'code' ? cell.execution_count ?? null : null,
    outputCount: Array.isArray(cell.outputs) ? cell.outputs.length : 0,
    hasError: Array.isArray(cell.outputs) && cell.outputs.some((output) => output.output_type === 'error'),
  };
}

export function newCell(cellType, source = '') {
  const cell = {
    cell_type: cellType,
    id: '',
    metadata: {},
    source: String(source ?? ''),
  };
  if (cellType === 'code') {
    cell.outputs = [];
    cell.execution_count = null;
  }
  return cell;
}
