"""DSH Jupyter kernel sidecar.

A small, dependency-light execution backend for the DSH Jupyter notebook
integration.  It speaks newline-delimited JSON over stdio with the Node MCP
server (``src/kernel.mjs``) and uses IPython for the execution semantics so
that magics (``%pip``, ``%%time``, ``%matplotlib``), ``!shell`` escapes and
rich display hooks behave the way notebook users expect.

Wire protocol
-------------
Requests (Node -> Python), one JSON object per line on stdin:

  {"op": "execute", "id": "<rid>", "code": "...", "silent": false}
  {"op": "interrupt"}
  {"op": "ping"}
  {"op": "shutdown"}

Responses (Python -> Node), one JSON object per line on the *original* stdout:

  {"type": "ready", ...}
  {"type": "status", "state": "busy"|"idle"}
  {"type": "stream", "id": "<rid>", "name": "stdout", "text": "..."}
  {"type": "execute_result"|"display_data", "id": "<rid>", "data": {...},
   "metadata": {...}, "execution_count": n}
  {"type": "error", "id": "<rid>", "ename": "...", "evalue": "...",
   "traceback": ["..."]}
  {"type": "done", "id": "<rid>", "status": "ok"|"error"|"interrupted",
   "execution_count": n, "duration_ms": n, "figure_count": n}
  {"type": "pong"}
  {"type": "fatal", "message": "..."}

The protocol channel is a duplicate of the real stdout file descriptor; fd 1
itself is pointed at stderr, so stray writes to file descriptor 1 from user
code can never corrupt the protocol stream.
"""

from __future__ import annotations

import base64
import ctypes
import io
import json
import os
import queue
import re
import sys
import threading
import time
import traceback

# --------------------------------------------------------------------------
# Protocol plumbing
# --------------------------------------------------------------------------

PROTO = None
_emit_lock = threading.Lock()
_MAX_TEXT = 200_000
_MAX_BUNDLE = 2_000_000


def _setup_protocol() -> None:
    """Take a private copy of stdout and point fd 1 at stderr."""
    global PROTO
    try:
        sys.stdout.flush()
    except Exception:
        pass
    dup = os.dup(1)
    PROTO = os.fdopen(dup, "w", encoding="utf-8", newline="\n", buffering=1)
    try:
        os.dup2(2, 1)
    except Exception:
        pass
    try:
        sys.stdout = sys.stderr  # anything printing to sys.stdout lands on stderr
    except Exception:
        pass


def emit(message: dict) -> None:
    if PROTO is None:
        return
    line = json.dumps(message, ensure_ascii=False, default=_json_default)
    with _emit_lock:
        try:
            PROTO.write(line + "\n")
            PROTO.flush()
        except Exception:
            pass


def _json_default(value):
    try:
        return repr(value)
    except Exception:
        return "<unserializable>"


def truncate(text: str, limit: int = _MAX_TEXT) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [truncated {len(text) - limit} characters]"


# --------------------------------------------------------------------------
# HTML table -> markdown (chat-side readability; the .ipynb keeps the HTML)
# --------------------------------------------------------------------------

_TAG_RE = re.compile(r"<[^>]+>")
_ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)
_CELL_RE = re.compile(r"<t([hd])[^>]*>(.*?)</t[hd]>", re.S | re.I)


def _strip(html: str) -> str:
    text = _TAG_RE.sub("", html)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )
    return re.sub(r"\s+", " ", text).strip()


def html_table_to_markdown(html: str, max_rows: int = 40) -> str | None:
    """Convert a simple HTML table (pandas ``_repr_html_``) into markdown."""
    if "<table" not in html.lower():
        return None
    rows = _ROW_RE.findall(html)
    if not rows:
        return None
    grid: list[list[str]] = []
    for row in rows:
        cells = _CELL_RE.findall(row)
        if not cells:
            continue
        grid.append([_strip(text) for _tag, text in cells])
    if len(grid) < 2:
        return None
    width = max(len(r) for r in grid)
    grid = [r + [""] * (width - len(r)) for r in grid]
    header, body = grid[0], grid[1:]
    truncated = False
    if len(body) > max_rows:
        body = body[:max_rows]
        truncated = True
    escape = lambda value: value.replace("|", "\\|")
    lines = ["| " + " | ".join(escape(c) for c in header) + " |",
             "| " + " | ".join("---" for _ in header) + " |"]
    for row in body:
        lines.append("| " + " | ".join(escape(c) for c in row) + " |")
    if truncated:
        lines.append(f"| ... ({len(grid) - 1 - max_rows} more rows in the notebook output) |"
                     + " |" * (width - 1))
    return "\n".join(lines)


# --------------------------------------------------------------------------
# Output capture
# --------------------------------------------------------------------------

class _StreamCapture(io.TextIOBase):
    """Replacement for sys.stdout / sys.stderr during a cell run."""

    def __init__(self, emit_stream, name: str):
        self._emit = emit_stream
        self._name = name

    @property
    def encoding(self):  # some libraries poke at this
        return "utf-8"

    def writable(self):
        return True

    def write(self, text):
        if not isinstance(text, str):
            text = str(text)
        if text:
            self._emit(text)
        return len(text)

    def flush(self):
        return None

    def isatty(self):
        return False


class OutputCollector:
    """Accumulates the outputs of one cell in nbformat shape."""

    def __init__(self, request_id: str):
        self.id = request_id
        self.outputs: list[dict] = []
        self.figure_count = 0
        # stream coalescing
        self._stream_name = None
        self._stream_buf: list[str] = []
        # live (panel streaming) line buffer
        self._live_buf: list[str] = []

    # -- streams ---------------------------------------------------------
    def stream(self, name: str, text: str) -> None:
        if self._stream_name == name:
            self._stream_buf.append(text)
        else:
            self.flush_stream()
            self._stream_name = name
            self._stream_buf = [text]
        # Live view: line-buffered so a slow cell streams while it runs without
        # one frame per print() fragment. Notebook output stays coalesced.
        self._live_buf.append(text)
        pending = "".join(self._live_buf)
        if pending.endswith(("\n", "\r")) or len(pending) >= 4096:
            emit({"type": "stream", "id": self.id, "name": name,
                  "text": truncate(pending)})
            self._live_buf = []
        if sum(len(chunk) for chunk in self._stream_buf) > 64_000:
            self.flush_stream()

    def flush_stream(self) -> None:
        if self._live_buf:
            emit({"type": "stream", "id": self.id, "name": self._stream_name or "stdout",
                  "text": truncate("".join(self._live_buf))})
            self._live_buf = []
        if not self._stream_buf:
            self._stream_name = None
            return
        text = "".join(self._stream_buf)[:_MAX_TEXT]
        output = {"output_type": "stream", "name": self._stream_name, "text": text}
        self.outputs.append(output)
        self._stream_buf = []
        self._stream_name = None

    # -- rich data -------------------------------------------------------
    def rich(self, data: dict, metadata: dict | None = None,
             output_type: str = "display_data", execution_count: int | None = None) -> None:
        self.flush_stream()
        data = dict(data or {})
        metadata = dict(metadata or {})
        if "image/png" in data:
            self.figure_count += 1
        # chat-side markdown fallback for HTML tables
        if "text/html" in data and "text/markdown" not in data:
            markdown = html_table_to_markdown(data["text/html"])
            if markdown:
                data["text/markdown"] = markdown
        payload = {key: truncate(value) if isinstance(value, str) and len(value) > _MAX_BUNDLE
                   else value for key, value in data.items()}
        output = {"output_type": output_type, "data": payload, "metadata": metadata}
        if output_type == "execute_result":
            output["execution_count"] = execution_count
        self.outputs.append(output)
        message = {"type": output_type, "id": self.id, "data": payload,
                   "metadata": metadata}
        if output_type == "execute_result":
            message["execution_count"] = execution_count
        emit(message)

    def error(self, ename: str, evalue: str, traceback_lines: list[str]) -> None:
        self.flush_stream()
        traceback_lines = [re.sub(r"\x1b\[[0-9;]*m", "", line) for line in traceback_lines]
        output = {"output_type": "error", "ename": ename, "evalue": evalue,
                  "traceback": traceback_lines}
        self.outputs.append(output)
        emit({"type": "error", "id": self.id, "ename": ename, "evalue": evalue,
              "traceback": traceback_lines})


# --------------------------------------------------------------------------
# Shell
# --------------------------------------------------------------------------

class Kernel:
    def __init__(self):
        self.shell = None
        self.collector: OutputCollector | None = None
        self.interrupt_requested = False
        self._interrupted_in_run = False
        self.executor_thread: threading.Thread | None = None
        self.works = queue.Queue()
        self.matplotlib = None
        self.figure_dir = os.environ.get("DSH_JUPYTER_FIGURE_DIR", "")

    # -- interrupt support ----------------------------------------------
    def _trace(self, frame, event, arg):
        if self.interrupt_requested:
            self.interrupt_requested = False
            self._interrupted_in_run = True
            raise KeyboardInterrupt()
        return self._trace

    def _async_raise(self) -> None:
        thread = self.executor_thread
        if thread is None or not thread.is_alive():
            return
        try:
            ctypes.pythonapi.PyThreadState_SetAsyncExc(
                ctypes.c_ulong(thread.ident), ctypes.py_object(KeyboardInterrupt)
            )
        except Exception:
            pass

    def request_interrupt(self) -> None:
        self.interrupt_requested = True
        self._async_raise()

    # -- IPython wiring --------------------------------------------------
    def build_shell(self) -> None:
        from IPython.core.interactiveshell import InteractiveShell
        from IPython.core.displayhook import DisplayHook
        from IPython.core.displaypub import DisplayPublisher

        kernel = self
        shell = InteractiveShell.instance()
        shell.colors = "NoColor"  # type: ignore[assignment]

        class Publisher(DisplayPublisher):
            def publish(self, data, metadata=None, source=None, *,
                        transient=None, update=False, **kwargs):
                if kernel.collector is not None:
                    kernel.collector.rich(data, metadata or {}, "display_data")

        class Hook(DisplayHook):
            def write_output_prompt(self):
                return None

            def write_format_data(self, format_dict, md_dict=None):
                if kernel.collector is not None:
                    kernel.collector.rich(
                        format_dict, md_dict or {}, "execute_result",
                        execution_count=shell.execution_count,
                    )

            def finish_displayhook(self):
                return None

        shell.display_pub = Publisher(shell=shell, parent=shell)  # type: ignore[assignment]
        hook = Hook(shell=shell, cache_size=1000)
        shell.displayhook = hook  # type: ignore[assignment]
        # InteractiveShell binds sys.displayhook through a DisplayTrap created in
        # init_displayhook(); rebuild it so the trap installs our hook.
        from IPython.core.display_trap import DisplayTrap

        shell.display_trap = DisplayTrap(hook=hook)  # type: ignore[assignment]

        def _record_traceback(*args, **kwargs):
            exc_tuple = kwargs.get("exc_tuple")
            if exc_tuple is None and args:
                exc_tuple = args[0] if isinstance(args[0], tuple) else None
            if exc_tuple is None:
                exc_tuple = sys.exc_info()
            etype, value, tb = exc_tuple
            if etype is None:
                return
            kernel._last_error = (
                etype.__name__,
                str(value),
                traceback.format_exception(etype, value, tb),
            )

        shell._showtraceback = _record_traceback  # type: ignore[attr-defined]
        self.shell = shell

    # -- matplotlib ------------------------------------------------------
    def setup_matplotlib(self) -> bool:
        try:
            import matplotlib
            matplotlib.use("Agg", force=True)
            import matplotlib.pyplot as plt
        except Exception:
            return False
        self.matplotlib = plt
        plt.rcParams["figure.max_open_warning"] = 0
        plt.show = lambda *a, **k: None  # type: ignore[assignment]
        return True

    def collect_figures(self, collector: OutputCollector,
                        execution_count: int | None = None) -> None:
        plt = self.matplotlib
        if plt is None:
            return
        try:
            numbers = list(plt.get_fignums())
        except Exception:
            return
        for number in numbers:
            try:
                figure = plt.figure(number)
                buf = io.BytesIO()
                figure.savefig(buf, format="png", bbox_inches="tight", dpi=110)
                payload = base64.b64encode(buf.getvalue()).decode("ascii")
                collector.rich(
                    {"image/png": payload,
                     "text/plain": f"<Figure {number} (matplotlib)>"},
                    {"width": int(figure.get_figwidth() * 110)},
                    "display_data",
                    execution_count=execution_count,
                )
            except Exception:
                pass
            try:
                plt.close(number)
            except Exception:
                pass

    # -- execution -------------------------------------------------------
    def run(self, request: dict) -> None:
        request_id = str(request.get("id") or "")
        code = request.get("code") or ""
        silent = bool(request.get("silent"))
        collector = OutputCollector(request_id)
        self.collector = collector
        self._last_error = None
        self.interrupt_requested = False
        self._interrupted_in_run = False
        started = time.time()

        def emit_stream(name):
            return lambda text: collector.stream(name, text)

        old_stdout, old_stderr = sys.stdout, sys.stderr
        sys.stdout = _StreamCapture(emit_stream("stdout"), "stdout")  # type: ignore[assignment]
        sys.stderr = _StreamCapture(emit_stream("stderr"), "stderr")  # type: ignore[assignment]
        emit({"type": "status", "state": "busy", "id": request_id})

        status = "ok"
        previous_trace = sys.gettrace()
        sys.settrace(self._trace)
        try:
            result = self.shell.run_cell(code, store_history=not silent, silent=silent)  # type: ignore[union-attr]
            self.collect_figures(collector, self.shell.execution_count)  # type: ignore[union-attr]
            error = self._last_error
            if self._interrupted_in_run:
                # IPython swallows KeyboardInterrupt internally; report the
                # interrupt we injected rather than the traceback it recorded.
                collector.error("KeyboardInterrupt", "Execution interrupted",
                                ["KeyboardInterrupt"])
                status = "interrupted"
            elif error is not None:
                collector.error(*error)
                status = "error"
            elif getattr(result, "error_before_exec", None) is not None:
                exc = result.error_before_exec
                collector.error(type(exc).__name__, str(exc),
                                traceback.format_exception(type(exc), exc, None))
                status = "error"
        except KeyboardInterrupt:
            status = "interrupted"
            collector.error("KeyboardInterrupt", "Execution interrupted", ["KeyboardInterrupt"])
        except SystemExit:
            status = "error"
            collector.error("SystemExit", "Cell called sys.exit()", ["SystemExit"])
        except BaseException as exc:  # noqa: BLE001 - never let the kernel die
            status = "error"
            collector.error(type(exc).__name__, str(exc),
                            traceback.format_exception(type(exc), exc, None))
        finally:
            sys.settrace(previous_trace)
            self.collector = None
            collector.flush_stream()
            sys.stdout, sys.stderr = old_stdout, old_stderr

        emit({
            "type": "done",
            "id": request_id,
            "status": status,
            "execution_count": getattr(self.shell, "execution_count", None),
            "duration_ms": int((time.time() - started) * 1000),
            "figure_count": collector.figure_count,
            "outputs": collector.outputs,
        })
        emit({"type": "status", "state": "idle", "id": request_id})

    # -- loops -----------------------------------------------------------
    def executor_loop(self) -> None:
        while True:
            request = self.works.get()
            if request is None:
                return
            try:
                self.run(request)
            except BaseException:  # noqa: BLE001
                emit({"type": "fatal", "message": traceback.format_exc()})

    def reader_loop(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except Exception:
                continue
            op = request.get("op")
            if op == "execute":
                self.works.put(request)
            elif op == "interrupt":
                self.request_interrupt()
            elif op == "ping":
                emit({"type": "pong"})
            elif op == "shutdown":
                self.works.put(None)
                return
        self.works.put(None)


def main() -> None:
    _setup_protocol()
    # A writable matplotlib cache keeps font-list warnings off stderr.  Keep it
    # inside the plugin directory: some hosts (and antivirus policies) deny a
    # Python child writes to the user profile, while the install tree is free.
    if not os.environ.get("MPLCONFIGDIR"):
        here = os.path.dirname(os.path.abspath(__file__))
        cache = os.path.join(here, "..", ".data", "mpl")
        try:
            os.makedirs(cache, exist_ok=True)
            os.environ["MPLCONFIGDIR"] = os.path.abspath(cache)
        except Exception:
            pass
    try:
        sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass
    kernel = Kernel()
    try:
        kernel.build_shell()
    except Exception:
        emit({"type": "fatal", "message": "IPython unavailable:\n" + traceback.format_exc()})
        return
    matplotlib_ready = kernel.setup_matplotlib()
    import IPython

    sys.path.insert(0, os.getcwd())
    emit({
        "type": "ready",
        "python": sys.version.split()[0],
        "ipython": IPython.__version__,
        "matplotlib": matplotlib_ready,
        "cwd": os.getcwd(),
        "pid": os.getpid(),
    })
    executor = threading.Thread(target=kernel.executor_loop, name="dsh-executor", daemon=True)
    kernel.executor_thread = executor
    executor.start()
    kernel.reader_loop()
    executor.join(timeout=1.0)


if __name__ == "__main__":
    main()
