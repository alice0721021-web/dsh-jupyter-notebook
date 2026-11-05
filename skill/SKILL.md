---
name: jupyter-notebook
description: Work with Jupyter notebooks (.ipynb) — create, read, edit and run cells on a live Python kernel, with figures and tables returned to the chat. Notebooks can live in the workspace or on a running Jupyter Server / JupyterLab. Use when the user asks for a notebook, wants to analyse data or prototype in Jupyter, mentions an .ipynb file, a notebook cell, JupyterLab or a Jupyter Server, or asks to run/re-run Python that must keep state between steps.
---

# Jupyter notebooks (DSH)

The `mcp__jupyter__*` tools own `.ipynb` files: read, edit and execute them
through these tools, never by editing notebook JSON with `read`/`write`/`edit`,
and never by starting `jupyter` in a shell.

Two places a notebook can live:

- **the workspace** (default) — a normal file next to the user's data, run in a
  private kernel this integration starts;
- **a Jupyter Server** — after `connect_server`, pass `server: "<name>"` to every
  tool; paths are then relative to the server root and execution uses the
  server's kernel, the same one JupyterLab shows.

Cell ids are stable; always address cells by `id`, never by index.

## 0. When the user means their running JupyterLab

If they say "my notebook", "the one open in JupyterLab", or paste a `http://…:8888/?token=…`
URL, call `list_servers` first. A local server is found automatically and its
token is used for you; a remote one needs `connect_server { url, token }`.
Then use that `server` name in every call. Do not copy the notebook to the
workspace — read and run it where it lives, so the user's JupyterLab sees the
same file. Never print the token back to the user.

## 1. Find or create

- `list_notebooks` with the workspace path (or `server`) lists folders and notebooks.
- `open_notebook` opens an existing notebook or creates one with
  `create: true`. It returns the revision plus every cell as
  `[index] type id=… rev=…`.
- Pass `root` (the workspace directory) when you use relative paths; absolute
  paths work as-is.

## 2. Read before editing

Call `read_notebook` before changing a notebook you have not read in this turn —
the user may have edited it in another editor. Use `cellIds` to read selected
cells, `includeImages: true` only when you actually need to look at a figure.

## 3. Edit

`edit_notebook` applies a list of operations in order and saves immediately:

- `insert` with `source`, `type` (`code` / `markdown` / `raw`) and `after`,
  `before` or `index` (default: append)
- `update` with the cell's **complete** new `source`; add `expectedRevision`
  (from the last read) when the cell may have changed
- `move`, `delete`, `set_type`, `clear_outputs`

Nothing is written if any operation fails, so a batch is all-or-nothing. On
`revision_conflict`, read the notebook again and redo the edit on the current
content — never overwrite the user's work blindly.

Write notebooks the way a person would: one short intro markdown cell, imports
in the first code cell, one logical step per cell, markdown between sections.

## 4. Run

`execute_cells` with `cellIds` (in order) or `all: true`. The kernel starts on
demand, the notebook's own directory is the working directory (so relative data
paths work), and outputs are stored in the notebook:

- Tables come back as markdown, plain results as text, errors as
  `ename: evalue` plus the failing line.
- Figures come back as images **and** as PNG files under
  `<notebook dir>/.dsh-jupyter/figures/` (workspace notebooks) or
  `<workspace>/.dsh-jupyter/figures/` (server notebooks). Show them to the user
  with the `present` tool (or embed them with `![…](path)`).
- On a connected server the kernel is the one the server already runs for that
  notebook, so the user's JupyterLab and this session share variables. If a cell
  needs something installed, `%pip install` installs into *their* environment —
  confirm first.
- The default call budget is 300 s. If a cell is still running, the tool says
  so; its outputs land in the notebook when it finishes — check later with
  `read_notebook` instead of blocking, and use `interrupt_kernel` or
  `restart_kernel` to stop it.
- A failing cell stops the batch (like Jupyter). Fix it and run again.
- `restart_kernel` clears all state; `restart_kernel` with `runAll: true` is the
  "restart and run all" users expect after stale imports.
- `kernel_status` reports which kernels are open and busy, and which servers are
  connected.

Missing package? `%pip install <package>` inside a cell installs into the
kernel's environment — ask the user before installing anything heavy.

## 5. Report

Summarise in a few sentences and refer to cells by index; the outputs are in the
notebook file, so do not paste whole tables or tracebacks into the chat. When
the user wants to read the notebook outside DSH, call `export_notebook` with
`format: "html"` and present the file. The notebook itself is usually the
deliverable: give its path.
