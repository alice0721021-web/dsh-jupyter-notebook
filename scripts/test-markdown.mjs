// Unit checks for the panel's inline markdown renderer.
//
// The renderer lives in client.js inside the browser module factory, so this
// test lifts the two functions out of that file and runs them against a tiny
// React stub. It proves structure and escaping without needing a browser or a
// DOM, and guards against a renderer regression that would only show up when a
// notebook with markdown is opened.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = await fs.readFile(path.resolve(HERE, '..', 'client.js'), 'utf8');

const start = source.indexOf('function inlineMarkdown(');
const end = source.indexOf('async function request(');
assert.ok(start > 0 && end > start, 'could not locate the markdown renderer in client.js');

const code = source.slice(start, end);
const h = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
});
const React = { Fragment: '#fragment' };
// eslint-disable-next-line no-new-func
const renderMarkdown = new Function('h', 'React', `${code}\nreturn renderMarkdown;`)(h, React);

/** Deterministic text form of a rendered tree, close enough to HTML to assert on. */
function text(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (node.type === '#fragment') return node.children.map(text).join('');
  const inner = node.children.map(text).join('');
  if (node.type === 'a') return `<a href="${node.props.href}">${inner}</a>`;
  return `<${node.type}>${inner}</${node.type}>`;
}

const rendered = (markdown) => text(renderMarkdown(markdown));

assert.equal(rendered('# Title'), '<h1>Title</h1>', 'headings');
assert.equal(rendered('### Third'), '<h3>Third</h3>', 'heading level');
assert.equal(rendered('plain **bold** and *em* and `code`'), '<p>plain <strong>bold</strong> and <em>em</em> and <code>code</code></p>', 'inline emphasis');
assert.equal(rendered('- one\n- two'), '<ul><li>one</li><li>two</li></ul>', 'unordered list');
assert.equal(rendered('1. first\n2. second'), '<ol><li>first</li><li>second</li></ol>', 'ordered list');
assert.equal(rendered('```py\nprint(1)\n```'), '<pre><code>print(1)</code></pre>', 'fenced code');
assert.equal(rendered('a\nb'), '<p>a b</p>', 'paragraph join');
assert.equal(rendered('---'), '<hr></hr>', 'rule');
assert.equal(rendered('> quoted'), '<blockquote><p>quoted</p></blockquote>', 'blockquote');
assert.equal(
  rendered('| a | b |\n| --- | --- |\n| 1 | 2 |'),
  '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
  'table',
);

/** Every element type present in a rendered tree. */
function elementTypes(node, found = new Set()) {
  if (node === null || node === undefined) return found;
  if (Array.isArray(node)) {
    for (const child of node) elementTypes(child, found);
    return found;
  }
  if (typeof node === 'string' || typeof node === 'number') return found;
  if (node.type !== '#fragment') found.add(node.type);
  for (const child of node.children) elementTypes(child, found);
  return found;
}

/** All text content in a rendered tree. */
function allText(node) {
  if (node === null || node === undefined) return '';
  if (Array.isArray(node)) return node.map((child) => allText(child)).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node.children.map((child) => allText(child)).join('');
}

// Markdown is rendered to React elements, never to HTML: markup in the source
// stays a text child and never becomes an element.
const scriptTree = renderMarkdown('<script>alert(1)</script>');
assert.deepEqual([...elementTypes(scriptTree)], ['p'], 'raw html produces no script element');
assert.equal(allText(scriptTree), '<script>alert(1)</script>', 'raw html survives as literal text');
const imageTree = renderMarkdown('<img src=x onerror=alert(1)>');
assert.deepEqual([...elementTypes(imageTree)], ['p'], 'raw html produces no img element');

// Links: only http(s), root-relative, relative and anchors stay links.
assert.equal(rendered('[docs](https://example.com/a)'), '<p><a href="https://example.com/a">docs</a></p>', 'https link');
assert.equal(rendered('[js](javascript:alert(1))'), '<p><span>js</span></p>', 'javascript: link is dropped');
assert.equal(rendered('[data](data:text/html,<b>)'), '<p><span>data</span></p>', 'data: link is dropped');

// A fence's body must not be parsed as markdown.
assert.equal(rendered('```\n# not a heading\n```'), '<pre><code># not a heading</code></pre>', 'fenced content is literal');

// Empty markdown still renders a placeholder node instead of nothing.
const emptyTree = renderMarkdown('   ');
assert.equal(emptyTree.length, 1, 'empty markdown renders one node');
assert.equal(emptyTree[0].props.className, 'djn-md-empty', 'empty markdown placeholder');

console.log('Markdown renderer checks passed: headings, inline, lists, code, quotes, tables, rules, escaping, link scheme filter.');
