// End-to-end smoke test: drive src/server.mjs exactly the way DSH does
// (MCP over stdio), using the same client SDK generation the harness pins.

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const workspace = path.join(ROOT, '.data', 'smoke-workspace');
const python = process.env.DSH_JUPYTER_PYTHON ?? path.join(ROOT, '.venv', 'Scripts', 'python.exe');

await fs.rm(workspace, { recursive: true, force: true });
await fs.mkdir(workspace, { recursive: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'src', 'server.mjs')],
  cwd: ROOT,
  env: {
    ...process.env,
    DSH_JUPYTER_PYTHON: python,
    DSH_JUPYTER_ROOT: workspace,
  },
  stderr: 'inherit',
});

const client = new Client({ name: 'dsh-smoke', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('TOOLS:', tools.map((tool) => tool.name).join(', '));

async function call(name, args) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const ms = Date.now() - started;
  const text = (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  const images = (result.content ?? []).filter((block) => block.type === 'image');
  console.log(`\n=== ${name} (${ms} ms, ${images.length} image block(s)) ===`);
  console.log(text.length > 2600 ? `${text.slice(0, 2600)}\n…[truncated for the log]` : text);
  if (result.isError) console.log('!! isError');
  return { text, images, result };
}

const created = await call('open_notebook', { path: 'analysis.ipynb', create: true });
const ids = [...created.text.matchAll(/id=([0-9a-z]{8})/g)].map((match) => match[1]);
console.log('cell ids:', ids);

await call('edit_notebook', {
  path: 'analysis.ipynb',
  operations: [
    { op: 'insert', type: 'markdown', source: '# Sales analysis\n\nA tiny demo notebook driven by the DSH smoke test.' },
    { op: 'insert', type: 'code', source: 'import pandas as pd\nimport numpy as np\n\nrng = np.random.default_rng(7)\ndf = pd.DataFrame({"month": ["Jan", "Feb", "Mar"], "total": rng.integers(10, 90, 3)})\ndf' },
    { op: 'insert', type: 'code', source: 'import matplotlib.pyplot as plt\n\nplt.figure(figsize=(5, 3))\nplt.bar(df["month"], df["total"], color="#4c8dff")\nplt.title("Monthly totals")\nplt.tight_layout()' },
    { op: 'insert', type: 'code', source: 'from pathlib import Path\nPath("data.csv").write_text("a,b\\n1,2\\n")\nprint("python cwd:", Path.cwd().name)\nprint("files:", sorted(p.name for p in Path.cwd().iterdir() if p.is_file()))' },
  ],
});

const read = await call('read_notebook', { path: 'analysis.ipynb' });
const refreshed = [...read.text.matchAll(/id=([0-9a-z]{8})/g)].map((match) => match[1]);
console.log('ids after insert:', refreshed);

await call('execute_cells', { path: 'analysis.ipynb', all: true, includeImages: true });
await call('kernel_status', {});
await call('read_notebook', { path: 'analysis.ipynb', includeImages: false });
await call('export_notebook', { path: 'analysis.ipynb', format: 'html' });

// error + revision conflict paths
await call('edit_notebook', {
  path: 'analysis.ipynb',
  operations: [{ op: 'insert', type: 'code', source: 'undefined_symbol + 1' }],
});
const failing = await call('execute_cells', { path: 'analysis.ipynb', all: true, includeImages: false });

const conflict = await client.callTool({
  name: 'edit_notebook',
  arguments: {
    path: 'analysis.ipynb',
    expectedRevision: 'deadbeefdead',
    operations: [{ op: 'insert', type: 'markdown', source: 'should not be written' }],
  },
});
console.log('\n=== conflict check ===');
console.log(JSON.stringify(conflict).slice(0, 400));

await call('restart_kernel', { path: 'analysis.ipynb' });
await call('interrupt_kernel', { path: 'analysis.ipynb' });

const saved = JSON.parse(await fs.readFile(path.join(workspace, 'analysis.ipynb'), 'utf8'));
console.log('\nnotebook cells:', saved.cells.length, 'nbformat:', saved.nbformat + '.' + saved.nbformat_minor);
console.log('outputs per cell:', saved.cells.map((cell) => (cell.outputs ?? []).length).join(','));
const figures = await fs.readdir(path.join(workspace, '.dsh-jupyter', 'figures')).catch(() => []);
console.log('figure files:', figures.join(', ') || '(none)');

await client.close();
