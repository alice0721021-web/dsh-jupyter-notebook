// Jupyter Server backend: contents API + kernels API + kernel execution over
// the Jupyter WebSocket channel.
//
// Used by two tools:
//   * list_servers / connect_server  — discovery and connection management
//   * every notebook tool with `server: ...` — the notebook then lives on that
//     server and executes in a kernel the server owns (shared with JupyterLab).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

export class ServerError extends Error {}

const REQUEST_TIMEOUT_MS = 30_000;
const WS_OPEN_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function normalizeUrl(input) {
  let raw = String(input ?? '').trim();
  if (!raw) throw new ServerError('server url is required');
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ServerError(`not a valid server url: ${input}`);
  }
  const token = url.searchParams.get('token') ?? undefined;
  url.searchParams.delete('token');
  url.hash = '';
  // Jupyter URLs are commonly pasted as ".../lab?token=…" or ".../tree".
  url.pathname = url.pathname.replace(/\/(lab|tree|notebooks)\/?$/i, '/');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return { base: url.toString(), token };
}

function wsBase(base) {
  return base.replace(/^http/i, 'ws');
}

function withToken(url, token) {
  if (!token) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('token', token);
  return parsed.toString();
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function runtimeDirs() {
  const dirs = [];
  if (process.env.JUPYTER_RUNTIME_DIR) dirs.push(process.env.JUPYTER_RUNTIME_DIR);
  if (process.platform === 'win32') {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'jupyter', 'runtime'));
  } else if (process.platform === 'darwin') {
    dirs.push(path.join(os.homedir(), 'Library', 'Jupyter', 'runtime'));
  } else {
    dirs.push(path.join(os.homedir(), '.local', 'share', 'jupyter', 'runtime'));
  }
  return [...new Set(dirs)];
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true; // unknown: let the probe decide
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function discoverServers({ probe = true } = {}) {
  const found = [];
  const seen = new Set();
  for (const dir of runtimeDirs()) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^(jpserver|nbserver)-\d+\.json$/.test(entry.name)) continue;
      let info;
      try {
        info = JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8'));
      } catch {
        continue;
      }
      const url = String(info.url ?? '').trim();
      if (!url || seen.has(url)) continue;
      if (!pidAlive(Number(info.pid))) continue;
      seen.add(url);
      const { base, token: urlToken } = normalizeUrl(url);
      const record = {
        file: path.join(dir, entry.name),
        url: base,
        // `info.token` is the connection token the server wrote for local use;
        // `password` is a HMAC of the cookie secret and is not usable as one.
        token: String(info.token ?? urlToken ?? ''),
        pid: Number(info.pid) || null,
        port: Number(info.port) || null,
        rootDir: info.root_dir ?? null,
        version: info.version ?? null,
        alive: null,
      };
      if (probe) {
        try {
          const response = await fetch(new URL('api/status', base), {
            headers: authHeaders(record.token),
            signal: AbortSignal.timeout(2500),
          });
          record.alive = response.ok;
          if (response.ok) {
            const body = await response.json();
            record.kernels = body.kernels ?? null;
            record.started = body.started ?? null;
          }
        } catch {
          record.alive = false;
        }
      }
      found.push(record);
    }
  }
  return found;
}

function authHeaders(token) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `token ${token}`;
  return headers;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class JupyterServerClient {
  constructor({ base, token = '', name = null }) {
    this.base = base;
    this.token = token;
    this.name = name;
    this.kernels = new Map(); // kernelId -> ServerKernel
  }

  static fromInput(input, token) {
    const normalized = normalizeUrl(input);
    return new JupyterServerClient({
      base: normalized.base,
      token: token ?? normalized.token ?? '',
      name: null,
    });
  }

  describe() {
    return {
      name: this.name,
      url: this.base,
      token: this.token ? '(set)' : '(none)',
      kernels: [...this.kernels.keys()].length,
    };
  }

  async request(apiPath, { method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const url = new URL(apiPath.replace(/^\//, ''), this.base).toString();
    const response = await fetch(url, {
      method,
      headers: {
        ...authHeaders(this.token),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error) => {
      throw new ServerError(`cannot reach ${this.base}: ${error.message}`);
    });
    if (response.status === 401 || response.status === 403) {
      throw new ServerError(`server rejected the token (${response.status}); pass the token JupyterLab uses`);
    }
    if (response.status === 404) {
      return { ok: false, status: 404, body: null };
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ServerError(`${method} ${apiPath} failed: ${response.status} ${detail.slice(0, 300)}`);
    }
    const type = response.headers.get('content-type') ?? '';
    return { ok: true, status: response.status, body: type.includes('json') ? await response.json() : await response.text() };
  }

  async status() {
    const { body } = await this.request('api/status', { timeoutMs: 8000 });
    return body;
  }

  async version() {
    const { body } = await this.request('api', { timeoutMs: 8000 }).catch(() => ({ body: null }));
    return body?.version ?? null;
  }

  async listContents(dirPath = '') {
    const { ok, body } = await this.request(`api/contents/${encodeURI(dirPath)}?content=1`);
    if (!ok) throw new ServerError(`no such directory on the server: /${dirPath}`);
    return body;
  }

  async readNotebook(notebookPath) {
    const { ok, body } = await this.request(`api/contents/${encodeURI(notebookPath)}?content=1&type=notebook`);
    if (!ok) return null;
    if (body?.type !== 'notebook' || body.format !== 'json') {
      throw new ServerError(`/${notebookPath} is not a JSON notebook (type=${body?.type})`);
    }
    return body;
  }

  async saveNotebook(notebookPath, nb) {
    const { ok, body } = await this.request(`api/contents/${encodeURI(notebookPath)}`, {
      method: 'PUT',
      body: { type: 'notebook', format: 'json', content: nb },
    });
    if (!ok) throw new ServerError(`cannot save /${notebookPath} on the server`);
    return body;
  }

  /** Rename or move a file on the server (the contents PATCH endpoint). */
  async renameNotebook(notebookPath, newPath) {
    const { ok, status, body } = await this.request(`api/contents/${encodeURI(notebookPath)}`, {
      method: 'PATCH',
      body: { path: newPath },
    });
    if (!ok) throw new ServerError(status === 404 ? `/${notebookPath} does not exist on the server` : `cannot rename /${notebookPath}`);
    return body;
  }

  async deleteNotebook(notebookPath) {
    const { ok } = await this.request(`api/contents/${encodeURI(notebookPath)}`, { method: 'DELETE' });
    if (!ok) throw new ServerError(`/${notebookPath} does not exist on the server`);
  }

  async sessions() {
    const { body } = await this.request('api/sessions');
    return Array.isArray(body) ? body : [];
  }

  async startKernel(name = 'python3') {
    const { body } = await this.request('api/kernels', { method: 'POST', body: { name } });
    return body;
  }

  /** Kernel names this server can start, as `{ name, displayName }`. */
  async kernelspecs() {
    const { body } = await this.request('api/kernelspecs', { timeoutMs: 10_000 });
    const specs = body?.kernelspecs ?? {};
    const preferred = body?.default;
    return Object.entries(specs).map(([name, spec]) => ({
      name,
      displayName: spec?.spec?.display_name ?? name,
      language: spec?.spec?.language ?? null,
      default: name === preferred,
    })).sort((a, b) => (b.default === a.default ? a.displayName.localeCompare(b.displayName) : b.default ? 1 : -1));
  }

  async deleteKernel(id) {
    await this.request(`api/kernels/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  }

  async interruptKernel(id) {
    await this.request(`api/kernels/${encodeURIComponent(id)}/interrupt`, { method: 'POST', body: {} });
  }

  async restartKernel(id) {
    const { body } = await this.request(`api/kernels/${encodeURIComponent(id)}/restart`, { method: 'POST', body: {} });
    return body;
  }

  async kernelModel(id) {
    const { ok, body } = await this.request(`api/kernels/${encodeURIComponent(id)}`);
    return ok ? body : null;
  }

  /**
   * Execute code in a kernel over the channels WebSocket.
   * Resolves with nbformat-shaped outputs once the kernel is idle again.
   */
  async execute(kernelId, code, { timeoutMs = 300_000, onOutput } = {}) {
    const socket = await this.openChannels(kernelId);
    const messageId = randomUUID();
    const outputs = [];
    let reply = null;
    let idle = false;
    let settled = false;
    const emit = (output) => {
      if (typeof onOutput !== 'function') return;
      try {
        onOutput(output);
      } catch {
        /* a streaming listener must never break execution */
      }
    };

    return new Promise((resolve, reject) => {
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        resolve({
          status: reply?.status === 'ok' ? 'ok' : reply?.status === 'error' ? 'error' : reply ? 'ok' : 'error',
          executionCount: reply?.execution_count ?? null,
          outputs,
          interrupted: Boolean(reply?.ename === 'KeyboardInterrupt'),
        });
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        reject(new ServerError(`kernel ${kernelId} did not answer within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      socket.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
        } catch {
          return;
        }
        const parent = message?.parent_header?.msg_id;
        if (parent !== messageId) return;
        const channel = message.channel ?? 'iopub';
        const type = message.header?.msg_type;
        const content = message.content ?? {};
        if (channel === 'shell' && type === 'execute_reply') {
          reply = content;
          // iopub idle usually lands right after the reply; give it a moment
          setTimeout(() => idle && finish(), 120);
        } else if (channel === 'iopub') {
          if (type === 'status' && content.execution_state === 'idle') {
            idle = true;
            if (reply) finish();
            return;
          }
          if (type === 'stream') {
            const text = String(content.text ?? '');
            const last = outputs[outputs.length - 1];
            if (last?.output_type === 'stream' && last.name === content.name) last.text += text;
            else outputs.push({ output_type: 'stream', name: content.name ?? 'stdout', text });
            emit({ output_type: 'stream', name: content.name ?? 'stdout', text });
            return;
          }
          if (type === 'execute_result' || type === 'display_data') {
            const data = scrubBundles(content.data ?? {});
            const output = {
              output_type: type === 'execute_result' ? 'execute_result' : 'display_data',
              data,
              metadata: content.metadata ?? {},
            };
            if (output.output_type === 'execute_result') output.execution_count = content.execution_count ?? null;
            outputs.push(output);
            emit(output);
            return;
          }
          if (type === 'error') {
            const output = {
              output_type: 'error',
              ename: content.ename ?? 'Error',
              evalue: content.evalue ?? '',
              traceback: (content.traceback ?? []).map((line) => stripAnsi(line)),
            };
            outputs.push(output);
            emit(output);
          }
        }
      });
      socket.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new ServerError(`websocket error while talking to kernel ${kernelId}`));
      });
      const send = () => {
        socket.send(JSON.stringify({
          header: {
            msg_id: messageId,
            username: 'dsh',
            session: randomUUID(),
            msg_type: 'execute_request',
            version: '5.3',
          },
          parent_header: {},
          metadata: {},
          content: {
            code,
            silent: false,
            store_history: true,
            user_expressions: {},
            allow_stdin: false,
            stop_on_error: true,
          },
          channel: 'shell',
        }));
      };
      if (socket.readyState === WebSocket.OPEN) send();
      else socket.addEventListener('open', send, { once: true });
    });
  }

  async openChannels(kernelId) {
    const url = withToken(`${wsBase(this.base)}api/kernels/${encodeURIComponent(kernelId)}/channels`, this.token);
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ServerError('websocket to the kernel did not open in time')), WS_OPEN_TIMEOUT_MS);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new ServerError(`cannot open the kernel websocket for ${kernelId}`));
      }, { once: true });
    });
    return socket;
  }
}

function stripAnsi(value) {
  return String(value ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

function stripHtml(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * HTML table (pandas `_repr_html_` and friends) -> markdown, so a server
 * kernel's DataFrame reaches the chat the same way a local kernel's does.
 */
export function htmlTableToMarkdown(html, maxRows = 40) {
  if (typeof html !== 'string' || !/<table/i.test(html)) return null;
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
  const grid = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<t([hd])[^>]*>([\s\S]*?)<\/t\1>/gi)].map((match) => stripHtml(match[2]));
    if (cells.length) grid.push(cells);
  }
  if (grid.length < 2) return null;
  const width = Math.max(...grid.map((row) => row.length));
  const padded = grid.map((row) => [...row, ...Array(width - row.length).fill('')]);
  const header = padded[0];
  let body = padded.slice(1);
  const truncated = body.length > maxRows;
  if (truncated) body = body.slice(0, maxRows);
  const escape = (value) => value.replace(/\|/g, '\\|');
  const lines = [
    `| ${header.map(escape).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.map(escape).join(' | ')} |`),
  ];
  if (truncated) lines.push(`| … (${padded.length - 1 - maxRows} more rows) |${' |'.repeat(Math.max(0, width - 1))}`);
  return lines.join('\n');
}

// Rich bundles can carry huge HTML; keep the notebook file intact but avoid
// exploding the tool result, and normalize the plain-text fallback.
function scrubBundles(data) {
  const out = {};
  for (const [mime, value] of Object.entries(data)) {
    if (typeof value === 'string') out[mime] = value.length > 400_000 ? value.slice(0, 400_000) : value;
    else if (Array.isArray(value)) out[mime] = value.join('');
    else out[mime] = value;
  }
  if (typeof out['text/html'] === 'string' && !out['text/markdown']) {
    const markdown = htmlTableToMarkdown(out['text/html']);
    if (markdown) out['text/markdown'] = markdown;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ServerKernel: the same surface NotebookKernel exposes to the tools
// ---------------------------------------------------------------------------

export class ServerKernel {
  constructor(client, { notebookPath, kernelSpec = 'python3' }) {
    this.client = client;
    this.notebookPath = notebookPath;
    this.kernelSpec = kernelSpec;
    this.kernelId = null;
    this.kernelName = kernelSpec;
    this.busy = null;
    this.executionCount = 0;
    this.lastUsed = Date.now();
    this.ready = null;
    this.info = null;
  }

  async start() {
    if (this.kernelId) return this;
    if (this.ready) return this.ready;
    this.ready = (async () => {
      // Reuse the kernel JupyterLab already opened for this notebook, so both
      // sides share one namespace.
      const sessions = await this.client.sessions().catch(() => []);
      const existing = sessions.find((session) => session.path === this.notebookPath && session.kernel?.id);
      if (existing) {
        this.kernelId = existing.kernel.id;
        this.kernelName = existing.kernel.name ?? this.kernelSpec;
        this.kernelReused = true;
      } else {
        const kernel = await this.client.startKernel(this.kernelSpec);
        this.kernelId = kernel.id;
        this.kernelName = kernel.name ?? this.kernelSpec;
        this.kernelReused = false;
      }
      this.client.kernels.set(this.kernelId, this);
      this.info = {
        kind: 'jupyter-server',
        URL: this.client.base,
        kernelId: this.kernelId,
        kernelName: this.kernelName,
        sharedWithLab: Boolean(this.kernelReused),
      };
      return this;
    })();
    return this.ready;
  }

  async execute(code, { timeoutMs = 300_000, onOutput } = {}) {
    await this.start();
    if (this.busy) throw new ServerError('the kernel is still running the previous cell; interrupt or restart it first');
    this.busy = true;
    this.lastUsed = Date.now();
    try {
      const started = Date.now();
      const result = await this.client.execute(this.kernelId, code, { timeoutMs, onOutput });
      this.executionCount = result.executionCount ?? this.executionCount;
      return {
        status: result.interrupted ? 'interrupted' : result.status,
        executionCount: result.executionCount,
        durationMs: Date.now() - started,
        figureCount: result.outputs.filter((output) => output.data?.['image/png']).length,
        outputs: result.outputs,
      };
    } finally {
      this.busy = null;
    }
  }

  async interrupt() {
    if (!this.kernelId) return false;
    await this.client.interruptKernel(this.kernelId);
    return true;
  }

  async restart() {
    if (!this.kernelId) return false;
    await this.client.restartKernel(this.kernelId);
    this.executionCount = 0;
    return true;
  }

  async dispose() {
    if (!this.kernelId) return;
    const id = this.kernelId;
    this.kernelId = null;
    this.ready = null;
    this.client.kernels.delete(id);
    await this.client.deleteKernel(id);
  }

  get alive() {
    return Boolean(this.kernelId);
  }

  describe() {
    return {
      pid: null,
      kernelId: this.kernelId,
      python: this.info?.kernelName ?? null,
      cwd: this.client.base,
      busy: Boolean(this.busy),
      executionCount: this.executionCount,
      info: this.info,
    };
  }
}
