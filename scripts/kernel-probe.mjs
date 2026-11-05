// Throwaway harness: talk to kernel/dsh_kernel.py over stdio and print traffic.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const python = process.argv[2];
const kernel = spawn(python, [path.join(here, '..', 'kernel', 'dsh_kernel.py')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  cwd: here,
});

const lines = [];
let buf = '';
kernel.stdout.setEncoding('utf8');
kernel.stdout.on('data', (chunk) => {
  buf += chunk;
  let index;
  while ((index = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, index);
    buf = buf.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    lines.push(message);
    console.log(JSON.stringify(message).slice(0, 600));
  }
});

const send = (payload) => kernel.stdin.write(JSON.stringify(payload) + '\n');
const waitFor = (type, timeout = 30000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const timer = setInterval(() => {
    const hit = lines.find((message) => message.type === type);
    if (hit) { clearInterval(timer); resolve(hit); }
    else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('timeout waiting for ' + type)); }
  }, 25);
});

await waitFor('ready', 60000);
console.log('--- ready ---');

let rid = 0;
const run = async (code) => {
  const id = String(++rid);
  lines.length = 0;
  send({ op: 'execute', id, code });
  await waitFor('done', 60000);
  const done = lines.find((m) => m.type === 'done');
  console.log(`### cell ${id} status=${done.status} ms=${done.duration_ms} figures=${done.figure_count}`);
  return done;
};

await run('print("hello from kernel")\n1+2');
await run('import pandas as pd\ndf = pd.DataFrame({"a":[1,2],"b":["x","y"]})\ndf');
await run('import matplotlib.pyplot as plt\nplt.plot([1,2,3],[3,2,1])\nplt.title("demo")');
await run('raise ValueError("boom")');
await run('%time sum(range(1000))');
await run('!echo shell-escape-works');
await run('undefined_name_here');

// interrupt test: long loop, interrupt after 1s
lines.length = 0;
send({ op: 'execute', id: '99', code: 'import time\nfor _ in range(10**9):\n    pass' });
setTimeout(() => send({ op: 'interrupt' }), 1000);
await waitFor('done', 20000);
console.log('interrupt ->', lines.find((m) => m.type === 'done')?.status);

send({ op: 'shutdown' });
setTimeout(() => kernel.kill(), 500);
