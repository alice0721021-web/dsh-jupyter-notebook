import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { disposePanelSessions, panelCall } from './src/panel-service.mjs';
import { disposeServerSessions, listServerTargets, serverCall } from './src/panel-server.mjs';

export const name = 'dsh-jupyter-notebook';
export const inject = ['webServer'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.DSH_JUPYTER_ROOT || process.cwd());
const PYTHON = process.env.DSH_JUPYTER_PYTHON || path.join(HERE, '.venv', 'Scripts', 'python.exe');
const ROUTE = '/api/dsh-jupyter-notebook';
const STREAMABLE = new Set(['run_cell', 'run_all']);
let disposed = false;
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', undefined]);

function isLoopbackHost(hostname) {
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname) || /^127(?:\.\d{1,3}){3}$/.test(hostname || '');
}

function isLocalRequest(request) {
  const remoteAddress = request?.socket?.remoteAddress;
  if (!LOCAL_ADDRESSES.has(remoteAddress) && !/^127(?:\.\d{1,3}){3}$/.test(remoteAddress || '')) return false;
  const host = request?.headers?.host;
  if (typeof host !== 'string') return true;
  try {
    return isLoopbackHost(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/**
 * A page on another origin can send a simple (preflight-free) POST to loopback.
 * Requiring a JSON content type makes the request non-simple, and checking
 * `Origin` rejects whatever still arrives from a non-local page.
 */
function isTrustedBrowserRequest(request) {
  const type = String(request?.headers?.['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('application/json')) return false;
  const origin = request?.headers?.origin;
  if (typeof origin !== 'string' || !origin) return true;
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function send(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

async function readBody(request, maxBytes = 2_000_000) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function apply(ctx, config = {}) {
  const normalise = (value) => {
    const resolved = path.resolve(String(value));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const allowedRoots = (defaultRoot) => {
    const allowed = new Map([[normalise(defaultRoot), path.resolve(defaultRoot)]]);
    let registry;
    try {
      registry = ctx.get('workspaceRegistry');
    } catch {
      registry = undefined;
    }
    for (const workspace of registry?.list?.() ?? []) {
      if (typeof workspace?.path === 'string' && workspace.path) allowed.set(normalise(workspace.path), path.resolve(workspace.path));
    }
    return allowed;
  };
  ctx.effect(() => {
    disposed = false;
    const root = path.resolve(config?.root || ROOT);
    const python = config?.python || PYTHON;
    const unregister = ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      async handler(request, response) {
        if (!isLocalRequest(request)) {
          send(response, 403, { error: 'local requests only' });
          return;
        }
        if (request.method !== 'POST') {
          send(response, 405, { error: 'POST required' });
          return;
        }
        if (!isTrustedBrowserRequest(request)) {
          send(response, 403, { error: 'requests must come from a local page as application/json' });
          return;
        }
        if (disposed) {
          send(response, 503, { error: 'Notebook panel is shutting down' });
          return;
        }
        let body;
        try {
          body = await readBody(request);
          if (!body || typeof body.method !== 'string' || body.method.length > 64) {
            throw new Error('invalid operation');
          }
          const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
          // Execution can stream: each output frame is one JSON line, and the
          // last frame carries the resulting notebook.
          const streaming = body.stream === true && STREAMABLE.has(body.method);
          let emit;
          if (streaming) {
            response.writeHead(200, {
              'content-type': 'application/x-ndjson; charset=utf-8',
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            });
            emit = (frame) => {
              if (response.writableEnded) return;
              try {
                response.write(`${JSON.stringify(frame)}\n`);
              } catch {
                /* the browser went away mid-run; the run itself keeps going */
              }
            };
          }
          const respond = (result) => {
            if (streaming) {
              emit({ type: 'result', result });
              response.end();
            } else send(response, 200, { result });
          };
          const fail = (error) => {
            if (streaming) {
              emit({ type: 'error', error: String(error?.message ?? error) });
              response.end();
            } else send(response, 400, { error: String(error?.message ?? error) });
          };
          try {
            if (body.method === 'list_servers') {
              respond(await listServerTargets());
              return;
            }
            if (typeof args.server === 'string' && args.server.trim()) {
              const { root: ignoredRoot, ...serverArgs } = args;
              respond(await serverCall(body.method, serverArgs, { onEvent: emit }));
              return;
            }
            const requestedRoot = args.root ? path.resolve(String(args.root)) : root;
            const allowed = allowedRoots(root);
            const notebookRoot = allowed.get(normalise(requestedRoot));
            if (!notebookRoot) throw new Error('notebook root must be the configured folder or a registered workspace');
            const { root: ignoredRoot, server: ignoredServer, ...operationArgs } = args;
            respond(await panelCall(body.method, operationArgs, { root: notebookRoot, packageRoot: HERE, python, onEvent: emit }));
          } catch (error) {
            fail(error);
          }
        } catch (error) {
          send(response, 400, { error: String(error?.message ?? error) });
        }
      },
    });
    return async () => {
      disposed = true;
      unregister();
      await Promise.allSettled([disposePanelSessions(), disposeServerSessions()]);
    };
  }, 'dsh-jupyter-notebook: local panel API');
}
