// Server-backend smoke test: connect to a real Jupyter Server and drive a
// notebook through the MCP tools (contents API + kernel WebSocket).
//
//   node scripts/smoke-server.mjs <url> <token> [name]
//
// The server must already be running; see README for how to start one.

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const url = process.argv[2] ?? 'http://127.0.0.1:8899/';
const token = process.argv[3] ?? 'smoke-token';
const name = process.argv[4] ?? 'test';

const workspace = path.join(ROOT, '.data', 'smoke-workspace');
const python = process.env.DSH_JUPYTER_PYTHON ?? path.join(ROOT, '.venv', 'Scripts', 'python.exe');
await fs.mkdir(workspace, { recursive: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'src', 'server.mjs')],
  cwd: ROOT,
  env: { ...process.env, DSH_JUPYTER_PYTHON: python, DSH_JUPYTER_ROOT: workspace },
  stderr: 'inherit',
});

const client = new Client({ name: 'dsh-smoke-server', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('TOOLS:', tools.map((tool) => tool.name).join(', '));

async function call(toolName, args) {
  const started = Date.now();
  const result = await client.callTool({ name: toolName, arguments: args });
  const text = (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  const images = (result.content ?? []).filter((block) => block.type === 'image');
  console.log(`\n=== ${toolName} (${Date.now() - started} ms, ${images.length} image(s), error=${Boolean(result.isError)}) ===`);
  console.log(text.length > 2200 ? `${text.slice(0, 2200)}\n…[truncated]` : text);
  return { text, images, isError: Boolean(result.isError) };
}

console.log('\n#### discovery');
await call('list_servers', {});

console.log('\n#### connect');
await call('connect_server', { url, token, name });
await call('connect_server', { url, token: 'definitely-wrong-token', name: 'bad' }); // must fail with a clear 401 message

console.log('\n#### contents API');
await call('list_notebooks', { server: name, path: '' });
await call('open_notebook', { server: name, path: 'server-demo.ipynb', create: true });
await call('edit_notebook', {
  server: name,
  path: 'server-demo.ipynb',
  operations: [
    { op: 'insert', type: 'markdown', source: '# Server-backed notebook\n\nCells live on the Jupyter Server; execution uses its kernel.' },
    { op: 'insert', type: 'code', source: 'import pandas as pd\nimport time\n\nstarted = time.time()\nframe = pd.DataFrame({"阶段": ["取数", "清洗", "建模"], "耗时秒": [1.2, 0.8, 3.4]})\nframe' },
    { op: 'insert', type: 'code', source: 'import matplotlib.pyplot as plt\n\nfig, ax = plt.subplots(figsize=(4.5, 2.6), dpi=110)\nax.bar(frame["阶段"], frame["耗时秒"], color="#4c8dff")\nax.set_title("耗时")\nfig.tight_layout()' },
    { op: 'insert', type: 'code', source: 'print("server kernel:", "state kept across tool calls")' },
  ],
});

console.log('\n#### execute through the server kernel');
await call('execute_cells', { server: name, path: 'server-demo.ipynb', all: true, includeImages: true });

console.log('\n#### second call must reuse the same kernel (variable from the first run)');
const edited = await call('edit_notebook', {
  server: name,
  path: 'server-demo.ipynb',
  operations: [{ op: 'insert', type: 'code', source: 'print("reused kernel, frame rows =", len(frame))' }],
});
const newId = [...edited.text.matchAll(/id=([0-9a-z]{8})/g)].pop()?.[1];
await call('execute_cells', { server: name, path: 'server-demo.ipynb', cellIds: [newId], includeImages: false });

console.log('\n#### kernel status');
await call('kernel_status', {});

console.log('\n#### restart drops state');
await call('restart_kernel', { server: name, path: 'server-demo.ipynb' });
await call('edit_notebook', {
  server: name,
  path: 'server-demo.ipynb',
  operations: [{ op: 'insert', type: 'code', source: 'print(len(frame))' }],
});
const afterRestart = await call('read_notebook', { server: name, path: 'server-demo.ipynb', includeOutputs: false });
const lastId = [...afterRestart.text.matchAll(/id=([0-9a-z]{8})/g)].pop()?.[1];
const stale = await call('execute_cells', { server: name, path: 'server-demo.ipynb', cellIds: [lastId], includeImages: false });
console.log(`state after restart: ${stale.text.includes('NameError') ? 'cleared (NameError as expected)' : 'STILL PRESENT — unexpected'}`);

console.log('\n#### reuse a kernel JupyterLab already opened');
const sharedPath = 'lab-shared.ipynb';
await call('open_notebook', { server: name, path: sharedPath, create: true });
const labSession = await fetch(new URL('api/sessions', url), {
  method: 'POST',
  headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: sharedPath, type: 'notebook', name: sharedPath, kernel: { name: 'python3' } }),
}).then((response) => response.json());
console.log(`JupyterLab-style session kernel: ${labSession.kernel?.id}`);
await call('edit_notebook', {
  server: name,
  path: sharedPath,
  operations: [{ op: 'insert', type: 'code', source: 'print("this cell should run in the JupyterLab kernel")' }],
});
await call('execute_cells', { server: name, path: sharedPath, all: true, includeImages: false });
await call('kernel_status', {});

console.log('\n#### export');
await call('export_notebook', { server: name, path: 'server-demo.ipynb', format: 'html' });

console.log('\n#### disconnect');
await call('disconnect_server', { server: name });

await client.close();
