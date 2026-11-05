// Notebook → panel view shapes.
//
// Both backends (local files and a Jupyter Server) return the same JSON to the
// Client, and the Client renders it with one set of components. Keeping that
// projection in a single module is what stops the two backends from drifting
// apart: a new output type, image limit or text cap is changed once.

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_MAX_CHARS = 4_000_000;
const TEXT_MAX_CHARS = 100_000;
const TRACEBACK_MAX_LINES = 8;

function textOfCell(cell) {
  const source = cell?.source;
  if (Array.isArray(source)) return source.join('');
  return typeof source === 'string' ? source : '';
}

/** nbformat output → the panel's renderable output. HTML stays a placeholder. */
export function viewOutput(output) {
  if (output?.output_type === 'stream' || output?.type === 'stream') {
    return { type: 'stream', name: output.name ?? 'stdout', text: String(output.text ?? '') };
  }
  if (output?.output_type === 'error' || output?.type === 'error') {
    return {
      type: 'error',
      name: String(output.ename ?? output.name ?? 'Error'),
      text: String(output.evalue ?? output.text ?? ''),
      traceback: Array.isArray(output.traceback) ? output.traceback.slice(-TRACEBACK_MAX_LINES) : [],
    };
  }
  const data = output?.data ?? {};
  const images = [];
  for (const mime of IMAGE_TYPES) {
    if (typeof data[mime] === 'string' && data[mime].length < IMAGE_MAX_CHARS) images.push({ mime, data: data[mime] });
  }
  const text = typeof data['text/plain'] === 'string' ? data['text/plain']
    : typeof data['text/markdown'] === 'string' ? data['text/markdown']
      : typeof data['text/html'] === 'string' ? `[HTML output omitted for safety: ${data['text/html'].length} characters]` : '';
  return { type: 'result', text: String(text).slice(0, TEXT_MAX_CHARS), images };
}

export function viewOutputs(outputs) {
  return (outputs ?? []).map(viewOutput);
}

/** nbformat cell → the panel's renderable cell. */
export function viewCell(cell, index) {
  return {
    id: cell.id,
    type: cell.cell_type,
    source: textOfCell(cell),
    executionCount: cell.execution_count ?? null,
    outputs: viewOutputs(cell.outputs),
    index,
  };
}

export function viewCells(cells) {
  return (cells ?? []).map(viewCell);
}
