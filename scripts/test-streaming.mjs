// Streaming checks for the panel's run path (local backend).
//
// Runs a cell that prints with pauses and records when each frame reaches the
// caller, proving output arrives during execution instead of only at the end.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { disposePanelSessions, panelCall } from '../src/panel-service.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.resolve(HERE, '..');
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-panel-stream-'));
const options = { root: ROOT, packageRoot: PACKAGE, python: process.env.DSH_JUPYTER_PYTHON || path.join(PACKAGE, '.venv', 'Scripts', 'python.exe') };

const code = [
  'import time',
  'for i in range(3):',
  "    print('tick', i, flush=True)",
  '    time.sleep(0.5)',
  "'done'",
].join('\n');

try {
  const created = await panelCall('open_notebook', { path: 'stream.ipynb', create: true }, options);
  const inserted = await panelCall('insert_cell', { path: 'stream.ipynb', type: 'code', expectedNotebookRevision: created.revision }, options);
  const cellId = inserted.cells[0].id;

  const frames = [];
  const startedAt = Date.now();
  const result = await panelCall('run_cell', {
    path: 'stream.ipynb',
    cellId,
    source: code,
    expectedNotebookRevision: inserted.revision,
  }, { ...options, onEvent: (frame) => frames.push({ at: Date.now() - startedAt, frame } ) });

  const outputs = frames.filter((entry) => entry.frame.type === 'output');
  const ticks = outputs.filter((entry) => String(entry.frame.output?.text ?? '').includes('tick'));
  assert.ok(ticks.length >= 3, `expected at least three streamed chunks, got ${ticks.length}: ${JSON.stringify(frames.map((entry) => entry.frame.type))}`);

  const firstTick = ticks[0].at;
  const finishedAt = Date.now() - startedAt;
  assert.ok(firstTick < finishedAt - 600, `first chunk should arrive well before the run ends (first=${firstTick}ms, end=${finishedAt}ms)`);
  for (let index = 1; index < ticks.length; index += 1) {
    assert.ok(ticks[index].at >= ticks[index - 1].at, 'frames arrive in order');
  }
  assert.ok(ticks[ticks.length - 1].at - ticks[0].at > 400, 'chunks are spread across the run, not flushed at the end');

  const done = frames.find((entry) => entry.frame.type === 'cell-done');
  assert.ok(done, 'a cell-done frame is sent');
  assert.ok(Array.isArray(done.frame.outputs), 'cell-done carries the final outputs');
  assert.equal(result.run[0].status, 'ok');
  assert.match(result.cells[0].outputs.map((output) => output.text).join(''), /tick 0[\s\S]*tick 1[\s\S]*tick 2/);
  assert.ok(result.cells[0].outputs.some((output) => output.text.includes('done')), 'the final result output is kept');

  console.log(`Panel streaming checks passed: ${ticks.length} chunks, first at ${firstTick}ms, run ended at ${finishedAt}ms.`);
} finally {
  await disposePanelSessions();
  await fs.rm(ROOT, { recursive: true, force: true });
}
