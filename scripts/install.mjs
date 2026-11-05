// Register the DSH Jupyter notebook integration with a DSH profile.
//
//   node scripts/install.mjs [--profile desktop] [--root F:\workspace]
//                            [--python <python.exe>] [--dry-run] [--uninstall]
//
// The installer is idempotent: it rewrites the marked block in the profile's
// cordis.patch.yml, installs the skill and verifies the MCP server handshake.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const BEGIN = '# === dsh-jupyter-notebook BEGIN ===';
const END = '# === dsh-jupyter-notebook END ===';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : true;
}

const dryRun = Boolean(arg('dry-run', false));
const uninstall = Boolean(arg('uninstall', false));
const profile = String(arg('profile', 'desktop'));
const workspace = path.resolve(String(arg('root', process.cwd())));
const dshHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
const nodeBinary = String(arg('node', process.env.DSH_JUPYTER_NODE || defaultNode()));
const pythonBinary = String(
  arg('python', process.env.DSH_JUPYTER_PYTHON || path.join(PLUGIN_ROOT, '.venv', 'Scripts', 'python.exe')),
);

function defaultNode() {
  const runtime = path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');
  return process.env.DSH_NODE || runtime;
}

function quoteYaml(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function block() {
  return [
    BEGIN,
    '# Written by dsh-jupyter-notebook/scripts/install.mjs — edit the installer, not this block.',
    '- insert:',
    '    - id: mcp-jupyter',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: jupyter',
    '        transport: stdio',
    `        command: ${quoteYaml(nodeBinary)}`,
    '        args:',
    `          - ${quoteYaml(path.join(PLUGIN_ROOT, 'src', 'server.mjs'))}`,
    `        cwd: ${quoteYaml(workspace)}`,
    '        env:',
    `          DSH_JUPYTER_PYTHON: ${quoteYaml(pythonBinary)}`,
    `          DSH_JUPYTER_ROOT: ${quoteYaml(workspace)}`,
    '        toolCallTimeoutMs: 900000',
    END,
    '',
  ].join('\n');
}

async function exists(target) {
  return Boolean(await fs.stat(target).catch(() => null));
}

async function patchProfile() {
  const file = path.join(dshHome, 'profiles', profile, 'cordis.patch.yml');
  let current = '';
  try {
    current = await fs.readFile(file, 'utf8');
  } catch {
    throw new Error(`profile patch not found: ${file} (is the profile called "${profile}"?)`);
  }
  const start = current.indexOf(BEGIN);
  const stop = current.indexOf(END);
  let next;
  if (start >= 0 && stop > start) {
    const tail = current.slice(stop + END.length).replace(/^\r?\n/, '');
    next = uninstall
      ? `${current.slice(0, start)}${tail}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
      : `${current.slice(0, start)}${block()}${tail}`;
  } else if (uninstall) {
    return { file, changed: false };
  } else {
    const separator = current.endsWith('\n') ? '' : '\n';
    next = `${current}${separator}\n${block()}`;
  }
  if (next === current) return { file, changed: false };
  if (dryRun) return { file, changed: true, preview: next.slice(Math.max(0, next.length - 900)) };
  const { parse } = await import('yaml');
  const document = parse(next);
  if (!Array.isArray(document)) throw new Error(`refusing to write: ${file} is not a patch list`);
  const ours = document.find((entry) => Array.isArray(entry?.insert)
    && entry.insert.some((inserted) => inserted?.id === 'mcp-jupyter'));
  if (!uninstall && !ours) throw new Error('refusing to write: the composed patch list has no mcp-jupyter entry');
  await fs.copyFile(file, `${file}.bak-dsh-jupyter-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fs.writeFile(file, next, 'utf8');
  return { file, changed: true };
}

async function installSkill() {
  const destination = path.join(dshHome, 'skills', 'jupyter-notebook', 'SKILL.md');
  const source = path.join(PLUGIN_ROOT, 'skill', 'SKILL.md');
  if (uninstall) {
    if (await exists(destination)) {
      if (dryRun) return { destination, changed: true };
      await fs.rm(path.dirname(destination), { recursive: true, force: true });
    }
    return { destination, changed: false };
  }
  const body = await fs.readFile(source, 'utf8');
  if (dryRun) return { destination, changed: true };
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, body, 'utf8');
  return { destination, changed: true };
}

async function verify() {
  if (dryRun) return 'skipped (dry run)';
  if (!(await exists(pythonBinary))) {
    return `python not found at ${pythonBinary} — create the venv first (see README)`;
  }
  const probe = spawn(pythonBinary, ['-c', 'import IPython, matplotlib; print(IPython.__version__)'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = await new Promise((resolve) => {
    let text = '';
    probe.stdout.on('data', (chunk) => { text += chunk; });
    probe.stderr.on('data', (chunk) => { text += chunk; });
    probe.on('exit', (code) => resolve({ code, text }));
  });
  if (output.code !== 0) return `python check failed:\n${output.text.trim()}`;

  const server = spawn(nodeBinary, [path.join(PLUGIN_ROOT, 'src', 'server.mjs')], {
    cwd: PLUGIN_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DSH_JUPYTER_PYTHON: pythonBinary, DSH_JUPYTER_ROOT: workspace },
  });
  const result = await new Promise((resolve) => {
    let buffer = '';
    const timer = setTimeout(() => resolve({ ok: false, reason: 'no initialize response within 20s' }), 20_000);
    server.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('"tools":[')) {
        clearTimeout(timer);
        const names = [...buffer.matchAll(/"name":"([a-z_]+)"/g)].map((match) => match[1]);
        resolve({ ok: names.length > 0, tools: [...new Set(names)].join(', ') || '(none)' });
      }
    });
    server.stderr.on('data', () => {});
    server.on('exit', () => {
      clearTimeout(timer);
      resolve({ ok: false, reason: 'server exited early' });
    });
    const send = (message) => server.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'dsh-jupyter-installer', version: '1.0.0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
  try {
    server.kill();
  } catch {
    /* ignore */
  }
  return result.ok ? `handshake ok — tools: ${result.tools}` : `handshake failed: ${result.reason}`;
}

const patched = await patchProfile();
const skill = await installSkill();
const verification = await verify();

console.log(uninstall ? 'dsh-jupyter-notebook: uninstall' : 'dsh-jupyter-notebook: install');
console.log(`  plugin      ${PLUGIN_ROOT}`);
console.log(`  profile     ${path.join(dshHome, 'profiles', profile, 'cordis.patch.yml')} ${patched.changed ? '(updated)' : '(unchanged)'}`);
console.log(`  skill       ${skill.destination} ${skill.changed ? '(written)' : '(unchanged)'}`);
console.log(`  workspace   ${workspace}`);
console.log(`  python      ${pythonBinary}`);
console.log(`  node        ${nodeBinary}`);
console.log(`  verify      ${verification}`);
if (dryRun && patched.preview) console.log(`\n--- preview (tail) ---\n${patched.preview}`);
if (!uninstall) {
  console.log('\nNext: restart DeepSeek Harness (or reload the desktop profile) so the MCP server is spawned.');
  console.log('Then ask for a notebook — the tools appear as mcp__jupyter__*.');
}
