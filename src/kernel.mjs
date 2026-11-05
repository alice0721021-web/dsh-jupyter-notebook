// Python kernel process management for the DSH Jupyter integration.
//
// One kernel process per notebook: it runs the notebook's directory as its cwd
// (so relative data paths behave like Jupyter), keeps a live IPython namespace
// and speaks newline-delimited JSON with kernel/dsh_kernel.py.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KERNEL_SCRIPT = path.join(HERE, '..', 'kernel', 'dsh_kernel.py');

export class KernelError extends Error {}

export class NotebookKernel {
  constructor(options) {
    this.python = options.python;
    this.script = options.script ?? KERNEL_SCRIPT;
    this.cwd = options.cwd;
    this.env = options.env ?? {};
    this.child = null;
    this.ready = null;
    this.pending = new Map();
    this.buffer = '';
    this.stderrTail = [];
    this.executionCount = 0;
    this.disposed = false;
    this.lastUsed = Date.now();
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const child = spawn(this.python, [this.script], {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...this.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          PYTHONUNBUFFERED: '1',
          MPLBACKEND: 'Agg',
        },
        windowsHide: true,
      });
      this.child = child;

      const timer = setTimeout(() => {
        reject(new KernelError(`kernel did not become ready within 60s (${this.python})`));
      }, 60_000);

      const settle = (fn, value) => {
        clearTimeout(timer);
        fn(value);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        this.buffer += chunk;
        let index;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, index);
          this.buffer = this.buffer.slice(index + 1);
          if (line.trim()) this.handleLine(line);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        this.stderrTail.push(chunk);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      });
      child.on('error', (error) => {
        settle(reject, new KernelError(`failed to start kernel: ${error.message}`));
      });
      child.on('exit', (code, signal) => {
        const tail = this.stderrTail.join('').trim();
        const reason = new KernelError(
          `kernel exited (code=${code}${signal ? `, signal=${signal}` : ''})${tail ? `\n${tail.slice(-2000)}` : ''}`,
        );
        this.ready = null;
        this.child = null;
        for (const entry of this.pending.values()) entry.reject(reason);
        this.pending.clear();
        settle(reject, reason);
      });

      const onReady = (resolveReady) => (message) => {
        this.info = message;
        this.executionCount = 0;
        settle(resolveReady, message);
      };
      this._onReady = onReady(resolve);
    });
    return this.ready;
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    switch (message.type) {
      case 'ready':
        this._onReady?.(message);
        this._onReady = null;
        return;
      case 'fatal':
        this.lastFatal = message.message;
        return;
      case 'stream':
        this.dispatch(message.id, 'stream', message);
        return;
      case 'execute_result':
      case 'display_data':
      case 'error':
        this.dispatch(message.id, 'output', message);
        return;
      case 'done':
        this.executionCount = message.execution_count ?? this.executionCount;
        this.finish(message.id, message);
        return;
      default:
        return;
    }
  }

  dispatch(id, kind, message) {
    const entry = this.pending.get(id);
    if (!entry) return;
    if (kind === 'stream') entry.streams.push(message);
    else entry.outputs.push(message);
    if (entry.onEvent) {
      try {
        entry.onEvent(messageToOutput(message));
      } catch {
        /* a streaming listener must never break execution */
      }
    }
  }

  finish(id, message) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.lastUsed = Date.now();
    const outputs = Array.isArray(message.outputs) ? message.outputs : entry.outputs;
    entry.resolve({
      status: message.status,
      executionCount: message.execution_count ?? null,
      durationMs: message.duration_ms ?? null,
      figureCount: message.figure_count ?? 0,
      outputs: normalizeOutputs(outputs),
    });
  }

  write(payload) {
    if (!this.child || !this.child.stdin.writable) {
      throw new KernelError('kernel is not running');
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async execute(code, options = {}) {
    await this.start();
    if (this.busy) {
      throw new KernelError('the kernel is still running the previous cell; interrupt or restart it first');
    }
    const id = randomUUID();
    let rejectPending;
    const promise = new Promise((resolve, reject) => {
      rejectPending = reject;
      this.pending.set(id, { resolve, reject, outputs: [], streams: [], onEvent: options.onEvent });
    });
    this.busy = id;
    const signal = options.signal;
    const onAbort = () => {
      this.pending.delete(id);
      rejectPending(signal.reason instanceof Error ? signal.reason : new KernelError('kernel execution aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    this.lastUsed = Date.now();
    try {
      if (signal?.aborted) onAbort();
      else this.write({ op: 'execute', id, code: String(code ?? ''), silent: Boolean(options.silent) });
      const result = await promise;
      return result;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this.busy === id) this.busy = null;
    }
  }

  async interrupt() {
    if (!this.child) return false;
    this.write({ op: 'interrupt' });
    return true;
  }

  async ping() {
    if (!this.child) return false;
    this.write({ op: 'ping' });
    return true;
  }

  async dispose() {
    this.disposed = true;
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`);
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 1500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
    this.ready = null;
  }

  get alive() {
    return Boolean(this.child && !this.child.killed);
  }

  describe() {
    return {
      pid: this.child?.pid ?? null,
      python: this.python,
      cwd: this.cwd,
      busy: Boolean(this.busy),
      executionCount: this.executionCount,
      startedAt: this.info ? Date.now() : null,
      info: this.info ?? null,
    };
  }
}

/** One kernel protocol message as an nbformat-shaped output, for live streaming. */
export function messageToOutput(message) {
  if (message?.type === 'stream') {
    return { output_type: 'stream', name: message.name ?? 'stdout', text: String(message.text ?? '') };
  }
  if (message?.type === 'error') {
    return {
      output_type: 'error',
      ename: message.ename ?? 'Error',
      evalue: message.evalue ?? '',
      traceback: Array.isArray(message.traceback) ? message.traceback : [],
    };
  }
  const output = {
    output_type: message?.type === 'execute_result' ? 'execute_result' : 'display_data',
    data: message?.data && typeof message.data === 'object' ? message.data : {},
    metadata: message?.metadata && typeof message.metadata === 'object' ? message.metadata : {},
  };
  if (output.output_type === 'execute_result') output.execution_count = message?.execution_count ?? null;
  return output;
}

function normalizeOutputs(outputs) {
  return outputs.map((output) => {
    if (output.output_type === 'stream') {
      return { output_type: 'stream', name: output.name ?? 'stdout', text: String(output.text ?? '') };
    }
    if (output.output_type === 'error') {
      return {
        output_type: 'error',
        ename: output.ename ?? 'Error',
        evalue: output.evalue ?? '',
        traceback: Array.isArray(output.traceback) ? output.traceback : [],
      };
    }
    const data = output.data && typeof output.data === 'object' ? { ...output.data } : {};
    const normalized = {
      output_type: output.output_type === 'execute_result' ? 'execute_result' : 'display_data',
      data,
      metadata: output.metadata && typeof output.metadata === 'object' ? output.metadata : {},
    };
    if (normalized.output_type === 'execute_result') {
      normalized.execution_count = output.execution_count ?? null;
    }
    return normalized;
  });
}
