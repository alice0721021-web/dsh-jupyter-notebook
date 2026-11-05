window.__ModuleLoader__.load({
  id: 'dsh-jupyter-notebook',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;

    const endpoint = '/api/dsh-jupyter-notebook';
    const styles = `
      .djn-root{height:100%;min-height:0;display:grid;grid-template-columns:minmax(220px,270px) minmax(0,1fr);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:1.5}
      .djn-browser{min-height:0;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill)}
      .djn-browser-head,.djn-toolbar{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}
      .djn-browser-head{justify-content:space-between;font-weight:600}
      .djn-root-select{margin:8px 10px 0;max-width:calc(100% - 20px);font-size:12px}
      .djn-location{padding:8px 12px;color:var(--dsw-alias-label-secondary);font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;border-bottom:1px solid var(--dsw-alias-border-l1)}
      .djn-files{overflow:auto;min-height:0;flex:1;padding:6px}
      .djn-file{display:flex;width:100%;align-items:center;gap:9px;padding:8px 10px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;font:inherit;overflow-wrap:anywhere}
      .djn-file:hover,.djn-file[data-active=true]{background:var(--dsw-alias-bg-layer-1)}
      .djn-file-icon{width:17px;flex:none;color:var(--dsw-alias-label-secondary)}
      .djn-create{display:flex;gap:6px;padding:10px;border-top:1px solid var(--dsw-alias-border-l1)}
      .djn-create input{min-width:0;flex:1}
      .djn-work{min-width:0;min-height:0;display:flex;flex-direction:column}
      .djn-toolbar{min-height:52px;flex-wrap:wrap}
      .djn-title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
      .djn-status{font-size:12px;color:var(--dsw-alias-label-secondary)}
      .djn-cells{overflow:auto;min-height:0;flex:1;padding:14px clamp(12px,2vw,28px)}
      .djn-cell{margin:0 0 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
      .djn-cell-head{display:flex;align-items:center;gap:8px;min-height:38px;padding:5px 9px;border-bottom:1px solid var(--dsw-alias-border-l1)}
      .djn-count{width:34px;flex:none;color:var(--dsw-alias-label-secondary);font:12px ui-monospace,SFMono-Regular,Consolas,monospace}
      .djn-type{width:110px;flex:none}
      .djn-actions{display:flex;align-items:center;gap:4px;margin-left:auto}
      .djn-editor{display:block;box-sizing:border-box;width:100%;min-height:80px;resize:vertical;border:0;padding:12px 14px;background:transparent;color:var(--dsw-alias-label-primary);font:13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:4;outline:none}
      .djn-md{padding:12px 14px;min-height:24px;cursor:text;overflow-wrap:anywhere}
      .djn-md>*:first-child{margin-top:0}
      .djn-md>*:last-child{margin-bottom:0}
      .djn-md h1,.djn-md h2,.djn-md h3,.djn-md h4,.djn-md h5,.djn-md h6{margin:14px 0 8px;line-height:1.3;font-weight:600}
      .djn-md h1{font-size:1.5em}
      .djn-md h2{font-size:1.3em}
      .djn-md h3{font-size:1.15em}
      .djn-md h4,.djn-md h5,.djn-md h6{font-size:1em}
      .djn-md p,.djn-md ul,.djn-md ol,.djn-md blockquote,.djn-md pre,.djn-md table{margin:8px 0}
      .djn-md ul,.djn-md ol{padding-left:22px}
      .djn-md li{margin:2px 0}
      .djn-md code{padding:1px 5px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
      .djn-md pre{padding:10px 12px;border-radius:4px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);overflow:auto}
      .djn-md pre code{padding:0;background:transparent;font-size:12px}
      .djn-md blockquote{margin-left:0;padding:2px 12px;border-left:3px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
      .djn-md table{border-collapse:collapse;font-size:13px}
      .djn-md th,.djn-md td{padding:5px 10px;border:1px solid var(--dsw-alias-border-l1);text-align:left}
      .djn-md th{background:var(--dsw-alias-bg-layer-2);font-weight:600}
      .djn-md a{color:var(--dsw-alias-brand-primary);text-decoration:none}
      .djn-md a:hover{text-decoration:underline}
      .djn-md hr{margin:14px 0;border:0;border-top:1px solid var(--dsw-alias-border-l1)}
      .djn-md .djn-md-empty{color:var(--dsw-alias-label-secondary);font-style:italic}
      .djn-output{padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1);overflow:auto;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
      .djn-output[data-error=true]{color:var(--dsw-alias-state-error-primary)}
      .djn-output img{display:block;max-width:min(100%,900px);height:auto;margin:6px 0}
      .djn-empty{margin:auto;padding:32px;color:var(--dsw-alias-label-secondary);text-align:center}
      .djn-error{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;padding:9px 14px;color:var(--dsw-alias-state-error-primary);border-bottom:1px solid var(--dsw-alias-border-l1);overflow-wrap:anywhere}
      .djn-dismiss{flex:none;border:0;background:transparent;color:inherit;cursor:pointer;font-size:16px;line-height:1;padding:0 2px}
      .djn-connect{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
      .djn-connect input{flex:1;min-width:0}
      .djn-notice{padding:6px 14px;color:var(--dsw-alias-label-secondary)}
      .djn-button,.djn-select,.djn-input{box-sizing:border-box;min-height:32px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}
      .djn-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:5px 10px;cursor:pointer;white-space:nowrap}
      .djn-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
      .djn-button:disabled{opacity:.55;cursor:default}
      .djn-button[data-primary=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
      .djn-button[data-icon=true]{width:30px;min-width:30px;padding:4px}
      .djn-select{padding:4px 7px}
      .djn-input{min-width:0;padding:5px 8px}
      @media(max-width:760px){.djn-root{grid-template-columns:150px minmax(0,1fr)}.djn-browser-head{padding:10px}.djn-files{padding:4px}.djn-file{padding:7px 5px;font-size:12px}.djn-type{width:86px}.djn-toolbar{padding:9px}.djn-button{padding:5px 7px}.djn-actions{gap:2px}}
      @media(max-width:520px){.djn-root{grid-template-columns:112px minmax(0,1fr)}.djn-file-icon{display:none}.djn-browser-head{font-size:13px}.djn-cell-head{gap:3px;padding:4px}.djn-count{width:28px}.djn-type{width:76px}.djn-output{padding:8px}}
    `;

    function Glyph({ kind, size = 16 }) {
      const shapes = {
        notebook: [h('rect', { key: 'r', x: 5, y: 3, width: 14, height: 18, rx: 2 }), h('path', { key: 'p', d: 'M9 3v18M12 8h4M12 12h4M12 16h3' })],
        folder: [h('path', { key: 'p', d: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' })],
        file: [h('path', { key: 'p', d: 'M6 3h8l4 4v14H6zM14 3v5h5M9 12h6M9 16h6' })],
        plus: [h('path', { key: 'p', d: 'M12 5v14M5 12h14' })],
        play: [h('path', { key: 'p', d: 'm8 5 11 7-11 7z' })],
        trash: [h('path', { key: 'p', d: 'M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3' })],
        save: [h('path', { key: 'p', d: 'M5 4h12l3 3v13H4V4zM8 4v6h8V4M8 20v-7h8v7' })],
        refresh: [h('path', { key: 'p', d: 'M20 7v5h-5M4 17v-5h5M5 9a7 7 0 0 1 12-2l3 5M4 12l3 5a7 7 0 0 0 12-2' })],
        stop: [h('rect', { key: 'r', x: 6, y: 6, width: 12, height: 12, rx: 1 })],
        restart: [h('path', { key: 'p', d: 'M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5' })],
        back: [h('path', { key: 'p', d: 'm15 18-6-6 6-6M9 12h11' })],
        edit: [h('path', { key: 'p', d: 'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z' })],
        eye: [h('path', { key: 'p', d: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z' }), h('circle', { key: 'c', cx: 12, cy: 12, r: 2.6 })],
        up: [h('path', { key: 'p', d: 'M12 19V5M5 12l7-7 7 7' })],
        down: [h('path', { key: 'p', d: 'M12 5v14M5 12l7 7 7-7' })],
        eraser: [h('path', { key: 'p', d: 'M4 20h16M6 16l8-8 5 5-8 8H6zM14 8l2-2 5 5-2 2' })],
      };
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, ...(shapes[kind] || shapes.file));
    }

    /**
     * Minimal markdown renderer for markdown cells: headings, lists, quotes,
     * fenced code, tables, rules and inline emphasis/links. It builds React
     * elements instead of HTML strings, so no markup from a notebook can ever
     * be executed.
     */
    function inlineMarkdown(text, keyBase) {
      const nodes = [];
      const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(\[[^\]]+\]\((?:[^()\s]|\([^()\s]*\))+\))/g;
      let last = 0;
      let match;
      let index = 0;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index));
        const token = match[0];
        const key = `${keyBase}-${index++}`;
        if (token.startsWith('`')) nodes.push(h('code', { key }, token.slice(1, -1)));
        else if (token.startsWith('**') || token.startsWith('__')) nodes.push(h('strong', { key }, token.slice(2, -2)));
        else if (token.startsWith('[')) {
          const link = /^\[([^\]]+)\]\((.*)\)$/.exec(token);
          const href = link?.[2] ?? '';
          const safe = /^(https?:\/\/|\/|\.\/|\.\.\/|#)/i.test(href);
          nodes.push(safe
            ? h('a', { key, href, target: '_blank', rel: 'noreferrer noopener' }, link[1])
            : h('span', { key }, link?.[1] ?? token));
        } else nodes.push(h('em', { key }, token.slice(1, -1)));
        last = match.index + token.length;
      }
      if (last < text.length) nodes.push(text.slice(last));
      return nodes;
    }

    function renderMarkdown(source) {
      const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
      const blocks = [];
      let index = 0;
      let blockKey = 0;
      const push = (node) => blocks.push(node);

      while (index < lines.length) {
        const line = lines[index];
        if (!line.trim()) { index += 1; continue; }
        const key = `md-${blockKey++}`;

        const fence = /^\s*```(.*)$/.exec(line);
        if (fence) {
          const body = [];
          index += 1;
          while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) { body.push(lines[index]); index += 1; }
          index += 1;
          push(h('pre', { key }, h('code', null, body.join('\n'))));
          continue;
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          const level = heading[1].length;
          push(h(`h${level}`, { key }, ...inlineMarkdown(heading[2], key)));
          index += 1;
          continue;
        }

        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          push(h('hr', { key }));
          index += 1;
          continue;
        }

        if (/^\s*>/.test(line)) {
          const body = [];
          while (index < lines.length && /^\s*>/.test(lines[index])) { body.push(lines[index].replace(/^\s*>\s?/, '')); index += 1; }
          push(h('blockquote', { key }, ...renderMarkdown(body.join('\n')).map((node, position) => h(React.Fragment, { key: position }, node))));
          continue;
        }

        const bullet = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
        if (bullet) {
          const ordered = /\d/.test(bullet[1]);
          const items = [];
          while (index < lines.length) {
            const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(lines[index]);
            if (!item) break;
            items.push(item[1]);
            index += 1;
            while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[index])) {
              items[items.length - 1] += ` ${lines[index].trim()}`;
              index += 1;
            }
          }
          push(h(ordered ? 'ol' : 'ul', { key }, ...items.map((item, position) => h('li', { key: position }, ...inlineMarkdown(item, `${key}-${position}`)))));
          continue;
        }

        if (line.includes('|') && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1]) && lines[index + 1].includes('-')) {
          const split = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
          const header = split(line);
          index += 2;
          const rows = [];
          while (index < lines.length && lines[index].includes('|') && lines[index].trim()) { rows.push(split(lines[index])); index += 1; }
          push(h('table', { key },
            h('thead', null, h('tr', null, ...header.map((cell, position) => h('th', { key: position }, ...inlineMarkdown(cell, `${key}-h${position}`))))),
            h('tbody', null, ...rows.map((row, rowIndex) => h('tr', { key: rowIndex }, ...header.map((_, position) => h('td', { key: position }, ...inlineMarkdown(row[position] ?? '', `${key}-${rowIndex}-${position}`))))))));
          continue;
        }

        const paragraph = [];
        while (index < lines.length && lines[index].trim() && !/^\s*(?:#{1,6}\s|```|>|[-*+]\s|\d+[.)]\s)/.test(lines[index]) && !/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[index])) {
          paragraph.push(lines[index].trim());
          index += 1;
        }
        push(h('p', { key }, ...inlineMarkdown(paragraph.join(' '), key)));
      }
      return blocks.length ? blocks : [h('div', { key: 'empty', className: 'djn-md-empty' }, '')];
    }

    async function request(method, args, signal) {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }), signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
      return payload.result;
    }

    /** Stable selector identity: the slot hook re-reads it on every snapshot. */
    const selectWorkspaceItems = (snapshot) => snapshot.items;

    function NotebookPanel({ t, useWorkspaces }) {
      const [selectedRoot, setSelectedRoot] = useState('');
      const [localRoot, setLocalRoot] = useState('');
      const [serverUrl, setServerUrl] = useState('');
      const [servers, setServers] = useState([]);
      const [specs, setSpecs] = useState([]);
      const [specName, setSpecName] = useState('');
      const [manualOpen, setManualOpen] = useState(false);
      const [manualUrl, setManualUrl] = useState('http://');
      const [manualToken, setManualToken] = useState('');
      const [directory, setDirectory] = useState('.');
      const [listing, setListing] = useState(null);
      const [notebook, setNotebook] = useState(null);
      const [dirty, setDirty] = useState({});
      const [editing, setEditing] = useState({});
      const [live, setLive] = useState(null);
      const [newName, setNewName] = useState('');
      const [busy, setBusy] = useState(false);
      const [kernelBusy, setKernelBusy] = useState(false);
      const cancelExecution = React.useRef(null);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const rootReference = React.useRef('');
      const serverReference = React.useRef('');
      const workspaceItems = useWorkspaces(selectWorkspaceItems);
      const workspacePaths = Array.isArray(workspaceItems) ? workspaceItems.map((workspace) => ({ path: workspace.path, id: workspace.workspaceId })).filter((workspace) => typeof workspace.path === 'string') : [];

      const withBusy = async (task) => {
        setBusy(true); setError(''); setNotice('');
        try { return await task(); }
        catch (cause) { setError(String(cause?.message || cause)); return null; }
        finally { setBusy(false); }
      };
      /** Server targets send `server` (plus a token for a hand-added server); local sends its root. */
      const targetArgs = () => {
        if (!serverReference.current) return rootReference.current ? { root: rootReference.current } : {};
        const entry = servers.find((server) => server.url === serverReference.current);
        return { server: serverReference.current, ...(entry?.token ? { token: entry.token } : {}) };
      };
      const rootEntryPath = () => (serverReference.current ? '' : '.');
      const applyTarget = (next) => {
        serverReference.current = next.server || '';
        setServerUrl(serverReference.current);
        if (next.rootPath && !next.server) {
          rootReference.current = next.rootPath;
          setSelectedRoot(next.rootPath);
        }
      };
      const refreshList = async (path = directory) => {
        const next = await request('list_notebooks', { path, ...targetArgs() });
        applyTarget(next);
        setDirectory(next.path); setListing(next);
      };
      /** True when it is safe to replace the open notebook; asks first when edits are pending. */
      const canLeave = () => Object.keys(dirty).length === 0 || window.confirm(t('confirmDiscard'));
      const open = async (path) => {
        if (!canLeave()) return null;
        return withBusy(async () => {
          const next = await request('open_notebook', { path, ...targetArgs() });
          setNotebook(next); setDirty({}); setEditing({}); setNotice(''); setKernelBusy(Boolean(next.kernel?.busy));
        });
      };
      const reload = () => notebook && withBusy(async () => {
        const next = await request('read_notebook', { path: notebook.path, ...targetArgs() });
        setNotebook(next); setDirty({}); setEditing({}); setNotice(''); setKernelBusy(Boolean(next.kernel?.busy));
      });
      const restart = () => notebook && withBusy(async () => {
        const result = await request('restart', { path: notebook.path, ...targetArgs() });
        setNotebook(result.notebook); setDirty({}); setEditing({}); setKernelBusy(false); setNotice(result.message);
      });
      const stopKernel = () => notebook && withBusy(async () => {
        const result = await request('stop_kernel', { path: notebook.path, ...targetArgs() });
        if (result.notebook) setNotebook(result.notebook);
        setDirty({}); setKernelBusy(false); setNotice(result.message);
      });
      const moveCell = (cell, direction) => withBusy(async () => {
        const next = await request('move_cell', { path: notebook.path, ...targetArgs(), expectedNotebookRevision: notebook.revision, cellId: cell.id, direction });
        setNotebook(next);
      });
      const clearOutputs = (cell) => withBusy(async () => {
        const next = await request('clear_outputs', { path: notebook.path, ...targetArgs(), expectedNotebookRevision: notebook.revision, ...(cell ? { cellId: cell.id } : {}) });
        setNotebook(next); setDirty({});
      });
      const renameNotebook = () => {
        if (!notebook) return;
        const current = notebook.path.split('/').pop();
        const name = window.prompt(t('renamePrompt'), current);
        if (!name || name === current) return;
        const dir = notebook.path.includes('/') ? notebook.path.slice(0, notebook.path.lastIndexOf('/')) : '';
        const next = [dir, name.toLowerCase().endsWith('.ipynb') ? name : `${name}.ipynb`].filter(Boolean).join('/');
        return withBusy(async () => {
          const view = await request('rename_notebook', { path: notebook.path, newPath: next, ...targetArgs(), expectedNotebookRevision: notebook.revision });
          setNotebook(view); setDirty({}); setEditing({}); setNotice(`${t('renamedTo')} ${view.path}`);
          await refreshList();
        });
      };
      const removeNotebook = () => {
        if (!notebook || !window.confirm(t('confirmDeleteNotebook'))) return null;
        return withBusy(async () => {
          await request('delete_notebook', { path: notebook.path, ...targetArgs(), expectedNotebookRevision: notebook.revision });
          setNotebook(null); setDirty({}); setEditing({}); setLive(null); setNotice(t('notebookDeleted'));
          await refreshList();
        });
      };
      const connectManual = () => withBusy(async () => {
        const url = manualUrl.trim();
        const token = manualToken.trim();
        if (!url) throw new Error(t('serverUrl'));
        const probe = await request('list_notebooks', { server: url, ...(token ? { token } : {}), path: '' });
        setServers((old) => [...old.filter((entry) => entry.url !== probe.rootPath), { url: probe.rootPath, token, manual: true, alive: true }]);
        serverReference.current = probe.rootPath;
        setServerUrl(probe.rootPath);
        setLocalRoot('');
        setManualOpen(false); setManualToken('');
        setNotebook(null); setDirty({}); setEditing({}); setLive(null);
        setDirectory(probe.path); setListing(probe);
      });
      const saveCell = async (cell) => {
        const source = Object.hasOwn(dirty, cell.id) ? dirty[cell.id] : cell.source;
        const next = await request('save_cell', { path: notebook.path, ...targetArgs(), expectedNotebookRevision: notebook.revision, cellId: cell.id, source });
        setNotebook(next); setDirty((old) => { const copy = { ...old }; delete copy[cell.id]; return copy; });
        if (cell.type !== 'code') setEditing((old) => { const copy = { ...old }; delete copy[cell.id]; return copy; });
      };
      const insertCell = (type, afterId) => withBusy(async () => {
        const known = new Set(notebook.cells.map((cell) => cell.id));
        const next = await request('insert_cell', { path: notebook.path, ...targetArgs(), expectedNotebookRevision: notebook.revision, type, ...(afterId ? { afterId } : {}) });
        setNotebook(next);
        // A fresh text cell starts in edit mode; an empty preview would look
        // like nothing happened.
        const created = next.cells.find((cell) => !known.has(cell.id));
        if (created && created.type !== 'code') setEditing((old) => ({ ...old, [created.id]: true }));
      });
      const execute = (method, args) => withBusy(async () => {
        const controller = new AbortController();
        cancelExecution.current = controller;
        setKernelBusy(true);
        setLive({});
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              method,
              stream: true,
              args: { ...args, ...targetArgs(), expectedNotebookRevision: notebook.revision, ...(specName ? { kernelName: specName } : {}), ...(method === 'run_all' && Object.keys(dirty).length ? { dirty } : {}) },
            }),
            signal: controller.signal,
          });
          if (!response.ok) {
            const text = await response.text().catch(() => '');
            let message = `Request failed (${response.status})`;
            try { message = JSON.parse(text).error || message; } catch { /* keep the status message */ }
            throw new Error(message);
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let final = null;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              if (!line) continue;
              let frame;
              try { frame = JSON.parse(line); } catch { continue; }
              if (frame.type === 'output') appendLive(frame.cellId, frame.output);
              else if (frame.type === 'cell-done') setLive((old) => ({ ...(old ?? {}), [frame.cellId]: frame.outputs ?? [] }));
              else if (frame.type === 'result') final = frame.result;
              else if (frame.type === 'error') throw new Error(frame.error || 'run failed');
            }
          }
          if (!final) throw new Error('the run ended without a result');
          setNotebook(final); setDirty({});
          setKernelBusy(Boolean(final.kernel?.busy));
        } catch (cause) {
          if (controller.signal.aborted) {
            // Aborting only closes our socket; the kernel keeps running the
            // cell, so ask it to stop as part of the same action.
            setLive(null);
            try {
              const result = await request('interrupt', { path: notebook.path, ...targetArgs() });
              setNotice(result.message);
            } catch {
              setNotice(t('interrupted'));
            }
            return null;
          }
          throw cause;
        } finally {
          cancelExecution.current = null;
          setLive(null);
          setKernelBusy(false);
        }
      });
      /** Append one streamed output to the running cell, merging adjacent stream chunks. */
      const appendLive = (cellId, output) => {
        if (!output) return;
        setLive((old) => {
          const map = { ...(old ?? {}) };
          const list = [...(map[cellId] ?? [])];
          const last = list[list.length - 1];
          if (output.type === 'stream' && last?.type === 'stream' && last.name === output.name) {
            list[list.length - 1] = { ...last, text: `${last.text}${output.text}` };
          } else list.push(output);
          map[cellId] = list;
          return map;
        });
      };
      const runCell = (cell) => execute('run_cell', {
        path: notebook.path,
        cellId: cell.id,
        ...(Object.hasOwn(dirty, cell.id) ? { source: dirty[cell.id] } : {}),
      });
      const runAll = () => execute('run_all', { path: notebook.path, dirty });
      const selectTarget = (value) => {
        if (!canLeave()) return null;
        return withBusy(async () => {
          const isLocal = value.startsWith('local:');
          const root = isLocal ? value.slice('local:'.length) : '';
          serverReference.current = isLocal ? '' : value;
          setServerUrl(serverReference.current);
          setLocalRoot(root);
          if (isLocal) rootReference.current = root;
          setNotebook(null); setDirty({}); setEditing({}); setListing(null); setKernelBusy(false);
          setDirectory(isLocal ? '.' : '');
          const next = await request('list_notebooks', {
            path: isLocal ? '.' : '',
            ...(isLocal ? (rootReference.current ? { root: rootReference.current } : {}) : { server: value }),
          });
          applyTarget(next);
          setDirectory(next.path); setListing(next);
        });
      };

      useEffect(() => {
        request('list_servers', {})
          .then((result) => setServers(Array.isArray(result?.servers) ? result.servers : []))
          .catch(() => setServers([]));
        refreshList('.').catch((cause) => setError(String(cause?.message || cause)));
      }, []);

      useEffect(() => {
        if (!serverUrl) { setSpecs([]); setSpecName(''); return; }
        // A hand-added server needs its token on every call, so reuse the same
        // argument builder the notebook requests use.
        request('list_kernelspecs', targetArgs())
          .then((result) => {
            const list = Array.isArray(result?.kernelspecs) ? result.kernelspecs : [];
            setSpecs(list);
            setSpecName(list.find((spec) => spec.default)?.name ?? list[0]?.name ?? '');
          })
          .catch(() => { setSpecs([]); setSpecName(''); });
      }, [serverUrl]);

      // Transient status lines should not accumulate in the header forever.
      useEffect(() => {
        if (!notice) return undefined;
        const timer = setTimeout(() => setNotice(''), 6000);
        return () => clearTimeout(timer);
      }, [notice]);

      const button = (kind, label, action, disabled = false, primary = false) => h('button', {
        key: label, className: 'djn-button', type: 'button', title: label, 'aria-label': label,
        disabled: disabled || busy, 'data-primary': primary || undefined, onClick: action,
      }, h(Glyph, { kind, size: 15 }), label);
      const interruptButton = () => h('button', {
        key: 'interrupt', className: 'djn-button', type: 'button', title: t('interrupt'), 'aria-label': t('interrupt'),
        disabled: !kernelBusy && !notebook.kernel?.busy,
        onClick: async () => {
          setError('');
          // A run is in flight: abort it, and the run's own handler interrupts
          // the kernel. Otherwise the cell was started elsewhere (reload,
          // another client) and we can only ask the kernel to stop.
          if (cancelExecution.current) { cancelExecution.current.abort(); return; }
          try { const result = await request('interrupt', { path: notebook.path, ...targetArgs() }); setNotice(result.message); }
          catch (cause) { setError(String(cause?.message || cause)); }
          finally { setKernelBusy(false); }
        },
      }, h(Glyph, { kind: 'stop', size: 15 }), t('interrupt'));
      const iconButton = (kind, label, action, disabled = false) => h('button', {
        key: label, className: 'djn-button', type: 'button', title: label, 'aria-label': label,
        'data-icon': true, disabled: disabled || busy, onClick: action,
      }, h(Glyph, { kind, size: 15 }));
      const kernelLabel = (kernel) => {
        if (!kernel) return t('kernelStopped');
        if (kernel.info?.sharedWithLab) return t('sharedKernel');
        return t('kernelReady');
      };

      const browser = h('aside', { className: 'djn-browser' },
        h('div', { className: 'djn-browser-head' }, t('notebooks'), iconButton('refresh', t('refresh'), () => withBusy(() => refreshList()))),
        h('select', {
          className: 'djn-select djn-root-select', value: serverUrl || `local:${localRoot}`, 'aria-label': t('target'),
          onChange: (event) => {
            const value = event.target.value;
            if (value === '__connect__') { setManualOpen(true); return; }
            setManualOpen(false);
            selectTarget(value);
          },
        },
          h('option', { value: 'local:' }, `${t('localFolder')} · ${selectedRoot || t('defaultRoot')}`),
          ...workspacePaths.filter((workspace) => workspace.path !== selectedRoot).map((workspace) => h('option', { key: `ws-${workspace.id || workspace.path}`, value: `local:${workspace.path}` }, `${t('localFolder')} · ${workspace.path}`)),
          ...servers.map((server) => h('option', { key: server.url, value: server.url }, `${t('jupyterServer')} · ${server.url.replace(/\/$/, '')}`)),
          h('option', { value: '__connect__' }, `＋ ${t('connectServer')}`)),
        manualOpen && h('form', {
          className: 'djn-connect',
          onSubmit: (event) => { event.preventDefault(); connectManual(); },
        },
          h('input', { className: 'djn-input', value: manualUrl, placeholder: 'http://host:8888/', 'aria-label': t('serverUrl'), onChange: (event) => setManualUrl(event.target.value) }),
          h('input', { className: 'djn-input', type: 'password', value: manualToken, placeholder: t('token'), 'aria-label': t('token'), onChange: (event) => setManualToken(event.target.value) }),
          h('button', { className: 'djn-button', type: 'submit', disabled: busy, title: t('connect'), 'aria-label': t('connect') }, h(Glyph, { kind: 'plus', size: 15 }))),
        serverUrl && h('div', { className: 'djn-location', title: serverUrl }, `Jupyter · ${serverUrl}`),
        listing && h('div', { className: 'djn-location', title: listing.path }, listing.path || '/'),
        h('div', { className: 'djn-files' },
          directory !== '' && directory !== '.' && h('button', { className: 'djn-file', type: 'button', onClick: () => withBusy(() => refreshList(directory.split('/').slice(0, -1).join('/') || rootEntryPath())) }, h('span', { className: 'djn-file-icon' }, h(Glyph, { kind: 'back' })), t('parentFolder')),
          listing?.folders.map((folder) => h('button', { key: folder.path, className: 'djn-file', type: 'button', onClick: () => withBusy(() => refreshList(folder.path)) }, h('span', { className: 'djn-file-icon' }, h(Glyph, { kind: 'folder' })), folder.name)),
          listing?.notebooks.map((file) => h('button', { key: file.path, className: 'djn-file', type: 'button', 'data-active': notebook?.path === file.path, onClick: () => open(file.path) }, h('span', { className: 'djn-file-icon' }, h(Glyph, { kind: 'notebook' })), file.name)),
          listing && listing.folders.length === 0 && listing.notebooks.length === 0 && h('div', { className: 'djn-empty' }, t('emptyFolder'))),
        h('form', { className: 'djn-create', onSubmit: (event) => { event.preventDefault(); const path = [directory === '.' ? '' : directory, newName.trim().endsWith('.ipynb') ? newName.trim() : `${newName.trim()}.ipynb`].filter(Boolean).join('/'); if (!newName.trim()) return; withBusy(async () => { const next = await request('open_notebook', { path, create: true, ...targetArgs() }); setNotebook(next); setDirty({}); setNewName(''); await refreshList(directory); }); } },
          h('input', { className: 'djn-input', value: newName, placeholder: t('newNotebook'), 'aria-label': t('newNotebook'), onChange: (event) => setNewName(event.target.value) }),
          h('button', { className: 'djn-button', type: 'submit', title: t('createNotebook'), 'aria-label': t('createNotebook'), disabled: busy || !newName.trim() }, h(Glyph, { kind: 'plus' }))),
      );

      const cells = notebook ? notebook.cells.map((cell) => {
        const source = Object.hasOwn(dirty, cell.id) ? dirty[cell.id] : cell.source;
        const isText = cell.type === 'markdown' || cell.type === 'raw';
        const editingThis = !isText || Boolean(editing[cell.id]);
        const streamed = live && Object.hasOwn(live, cell.id) ? live[cell.id] : null;
        const shownOutputs = streamed ?? cell.outputs;
        const outputs = shownOutputs.map((output, index) => h('div', { key: `${cell.id}-${index}`, className: 'djn-output', 'data-error': output.type === 'error' || undefined },
          output.type === 'result' && output.images.map((image, imageIndex) => h('img', { key: imageIndex, src: `data:${image.mime};base64,${image.data}`, alt: t('figure') })),
          output.text && h('span', null, output.type === 'error' ? `${output.name}: ${output.text}${output.traceback.length ? `\n${output.traceback.join('\n')}` : ''}` : output.type === 'stream' ? `${output.name}: ${output.text}` : output.text)));
        const startEdit = (event) => {
          if (event.target.closest?.('a')) return;
          setEditing((old) => ({ ...old, [cell.id]: true }));
        };
        const body = editingThis
          ? h('textarea', { className: 'djn-editor', value: source, spellCheck: false, 'aria-label': `${t('cell')} ${cell.index + 1}`, onChange: (event) => setDirty((old) => ({ ...old, [cell.id]: event.target.value })) })
          : cell.type === 'markdown'
            ? h('div', { className: 'djn-md', title: t('editCell'), onClick: startEdit }, ...renderMarkdown(source))
            : h('div', { className: 'djn-md', title: t('editCell'), onClick: startEdit }, h('pre', null, h('code', null, source)));
        return h('article', { key: cell.id, className: 'djn-cell' },
          h('div', { className: 'djn-cell-head' },
            h('span', { className: 'djn-count' }, cell.type === 'code' ? `[${cell.executionCount ?? ' '}]` : '·'),
            h('select', { className: 'djn-select djn-type', value: cell.type, 'aria-label': t('cellType'), disabled: busy, onChange: (event) => withBusy(async () => { const next = await request('set_cell_type', { path: notebook.path, ...targetArgs(), expectedNotebookRevision: notebook.revision, cellId: cell.id, type: event.target.value }); setNotebook(next); setEditing((old) => { const copy = { ...old }; delete copy[cell.id]; return copy; }); }) },
              ...['code', 'markdown', 'raw'].map((type) => h('option', { key: type, value: type }, t(type)))),
            h('span', { className: 'djn-status' }, streamed ? t('running') : dirty[cell.id] !== undefined ? t('unsaved') : ''),
            h('div', { className: 'djn-actions' },
              cell.type === 'code' && iconButton('play', t('runCell'), () => runCell(cell)),
              isText && iconButton(editingThis ? 'eye' : 'edit', editingThis ? t('previewCell') : t('editCell'), () => setEditing((old) => { const copy = { ...old }; if (copy[cell.id]) delete copy[cell.id]; else copy[cell.id] = true; return copy; })),
              iconButton('save', t('saveCell'), () => withBusy(() => saveCell(cell)), dirty[cell.id] === undefined),
              iconButton('up', t('moveUp'), () => moveCell(cell, 'up'), cell.index === 0),
              iconButton('down', t('moveDown'), () => moveCell(cell, 'down'), cell.index === notebook.cells.length - 1),
              cell.type === 'code' && iconButton('eraser', t('clearOutputs'), () => clearOutputs(cell), cell.outputs.length === 0),
              iconButton('plus', t('insertBelow'), () => insertCell(cell.type, cell.id)),
              iconButton('trash', t('deleteCell'), () => { if (window.confirm(t('confirmDelete'))) withBusy(async () => { const next = await request('delete_cell', { path: notebook.path, ...targetArgs(), expectedNotebookRevision: notebook.revision, cellId: cell.id }); setNotebook(next); setDirty({}); }); }))),
          body,
          outputs.length ? h('div', null, outputs) : null);
      }) : h('div', { className: 'djn-empty' }, t('selectNotebook'));

      const work = h('section', { className: 'djn-work' },
        h('header', { className: 'djn-toolbar' },
          notebook && iconButton('back', t('backToList'), () => { if (canLeave()) { setNotebook(null); setDirty({}); setEditing({}); } }),
          h('div', { className: 'djn-title', title: notebook?.path || '' }, notebook?.path || t('notebookWorkspace')),
          notebook && h('span', { className: 'djn-status' }, kernelBusy || notebook.kernel?.busy ? t('kernelBusy') : kernelLabel(notebook.kernel)),
          notebook && button('play', t('runAll'), runAll, false, true),
          notebook && interruptButton(),
          notebook && iconButton('restart', t('restart'), restart),
          notebook && notebook.kernel && iconButton('stop', t('stopKernel'), stopKernel),
          notebook && !notebook.kernel && serverUrl && specs.length > 0 && h('select', { className: 'djn-select', value: specName, 'aria-label': t('kernelSpec'), title: t('kernelSpec'), disabled: busy, onChange: (event) => setSpecName(event.target.value) },
            ...specs.map((spec) => h('option', { key: spec.name, value: spec.name }, spec.displayName))),
          notebook && iconButton('edit', t('rename'), renameNotebook),
          notebook && iconButton('trash', t('deleteNotebook'), removeNotebook),
          notebook && button('refresh', t('reload'), reload)),
        error && h('div', { className: 'djn-error', role: 'alert' },
          h('span', null, error),
          h('button', { className: 'djn-dismiss', type: 'button', title: t('dismiss'), 'aria-label': t('dismiss'), onClick: () => setError('') }, '×')),
        notice && h('div', { className: 'djn-notice', role: 'status' }, notice),
        h('div', { className: 'djn-cells' }, cells,
          notebook && h('div', { style: { display: 'flex', gap: 8 } },
            button('plus', t('addCode'), () => insertCell('code', notebook.cells.at(-1)?.id)),
            button('plus', t('addMarkdown'), () => insertCell('markdown', notebook.cells.at(-1)?.id)),
            button('eraser', t('clearAllOutputs'), () => clearOutputs(null), notebook.cells.every((cell) => cell.outputs.length === 0)))));

      return h('div', { className: 'djn-root' }, h('style', null, styles), browser, work);
    }

    function SidebarIcon({ size = 20 }) {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, color: 'var(--dsw-alias-label-primary)' } }, h(Glyph, { kind: 'notebook', size }));
    }

    return {
      inject: ['slots', 'layout', 'locale'],
      apply(ctx) {
        const ns = 'dsh-jupyter-notebook';
        const t = ctx.locale.bind(ns);
        ctx.effect(() => {
          const disposer = ctx.locale.register(ns, { en: {
            notebooks: 'Notebooks', workspace: 'Notebook root', target: 'Notebook source', localFolder: 'Local folder', jupyterServer: 'Jupyter server', sharedKernel: 'Shared with JupyterLab', defaultRoot: 'Project folder', refresh: 'Refresh', parentFolder: 'Parent folder', emptyFolder: 'No notebooks in this folder', newNotebook: 'Notebook name', createNotebook: 'Create notebook', selectNotebook: 'Select a notebook from the file list', notebookWorkspace: 'Notebook workspace', kernelBusy: 'Kernel busy', kernelReady: 'Kernel ready', kernelStopped: 'Kernel stopped', runAll: 'Run all', interrupt: 'Interrupt', interrupted: 'Run interrupted', reload: 'Reload from disk', restart: 'Restart kernel', runCell: 'Run cell', saveCell: 'Save cell', insertBelow: 'Insert cell below', deleteCell: 'Delete cell', confirmDelete: 'Delete this cell?', cellType: 'Cell type', code: 'Code', markdown: 'Markdown', raw: 'Raw', unsaved: 'Unsaved', cell: 'Cell', figure: 'Notebook figure', backToList: 'Back to notebook list', addCode: 'Add code cell', addMarkdown: 'Add markdown cell', editCell: 'Edit cell', previewCell: 'Preview', confirmDiscard: 'Discard unsaved cell edits?', running: 'Running…', stopKernel: 'Stop kernel', kernelSpec: 'Kernel', moveUp: 'Move cell up', moveDown: 'Move cell down', clearOutputs: 'Clear outputs', clearAllOutputs: 'Clear all outputs', rename: 'Rename notebook', deleteNotebook: 'Delete notebook', renamePrompt: 'New notebook name', confirmDeleteNotebook: 'Delete this notebook file? This cannot be undone.', notebookDeleted: 'Notebook deleted', renamedTo: 'Renamed to', connectServer: 'Connect a server…', serverUrl: 'Server URL', token: 'Token (optional)', connect: 'Connect', dismiss: 'Dismiss',
          }, zh: {
            notebooks: 'Notebook', workspace: 'Notebook 根目录', target: 'Notebook 来源', localFolder: '本地目录', jupyterServer: 'Jupyter 服务', sharedKernel: '与 JupyterLab 共享内核', defaultRoot: '项目目录', refresh: '刷新', parentFolder: '上级目录', emptyFolder: '此目录没有 Notebook', newNotebook: 'Notebook 名称', createNotebook: '新建 Notebook', selectNotebook: '从文件列表选择一个 Notebook', notebookWorkspace: 'Notebook 工作区', kernelBusy: '内核运行中', kernelReady: '内核已就绪', kernelStopped: '内核未启动', runAll: '运行全部', interrupt: '中断', interrupted: '运行已中断', reload: '从磁盘重载', restart: '重启内核', runCell: '运行单元', saveCell: '保存单元', insertBelow: '在下方插入', deleteCell: '删除单元', confirmDelete: '确定删除这个单元？', cellType: '单元类型', code: '代码', markdown: 'Markdown', raw: '原始文本', unsaved: '未保存', cell: '单元', figure: 'Notebook 图像', backToList: '返回列表', addCode: '添加代码单元', addMarkdown: '添加 Markdown 单元', editCell: '编辑单元', previewCell: '预览', confirmDiscard: '有未保存的单元修改，确定放弃？', running: '运行中…', stopKernel: '停止内核', kernelSpec: '内核', moveUp: '上移单元', moveDown: '下移单元', clearOutputs: '清空输出', clearAllOutputs: '清空全部输出', rename: '重命名 Notebook', deleteNotebook: '删除 Notebook', renamePrompt: '新的 Notebook 名称', confirmDeleteNotebook: '删除这个 notebook 文件？无法撤销。', notebookDeleted: 'Notebook 已删除', renamedTo: '已重命名为', connectServer: '连接服务器…', serverUrl: '服务器地址', token: 'Token（可选）', connect: '连接', dismiss: '关闭',
          } });
          return disposer;
        }, 'dsh-jupyter-notebook: locale');
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'dsh-jupyter-notebook', order: 20, label: () => t('notebooks') }, SidebarIcon));
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'dsh-jupyter-notebook', locale: ns }, NotebookPanel));
      },
    };
  },
});
