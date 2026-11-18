// Checks of the shared engine's run-time files inside a built Bogen.app, used by verify-app.mjs. Pure Node, so the
// same checks also run on Linux against a staged copy of packages/server/dist (apps/macos/test/verify-engine.test.ts).
//
// Since engine 0.2.0 three things in the server depend on how the bundle is laid out:
// - The icon sets beyond Lucide are data files in server/dist/icon-sets/, read on first use (icon-set-files.ts). A
//   bundle without them still starts; only icon_search and icon_insert with such a set fail.
// - font_build writes a WOFF2 with woff2-encoder, whose WebAssembly is inlined in cli.js; under the hardened runtime
//   it compiles with the allow-jit entitlement like the rest of V8.
// - compliance_check runs axe-core (inlined in cli.js) in the bundled headless shell.
// staticEngineProblems looks at files; engineChecks drives the bundled server over `bogen mcp` (stdio).

import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The icon set files a build must carry: those in packages/core/src/icon-sets of this checkout. */
export function expectedIconSets(repoRoot) {
  return readdirSync(join(repoRoot, 'packages', 'core', 'src', 'icon-sets')).filter((n) => n.endsWith('.json')).sort();
}

/** What is missing or empty in a server dist folder (Contents/Resources/server/dist); empty when complete. */
export function staticEngineProblems(dist, iconSets) {
  const out = [];
  if (!iconSets.length) out.push('no icon sets are expected: packages/core/src/icon-sets is empty');
  for (const name of iconSets) {
    const st = statSync(join(dist, 'icon-sets', name), { throwIfNoEntry: false });
    if (!st?.isFile()) out.push(`icon-sets/${name} is missing`);
    else if (st.size < 1024) out.push(`icon-sets/${name} is only ${st.size} bytes`);
  }
  // script_run loads its worker and QuickJS's WebAssembly next to cli.js; pdf_import and diagram_insert read pdf.js and
  // Mermaid from dist/vendor.
  for (const name of ['cli.js', 'vectorize-worker.js', 'shader-runtime.js', 'editor/index.html', 'script-worker.js', 'quickjs/quickjs-asyncify.wasm', 'vendor/mermaid.min.js', 'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs']) {
    if (!statSync(join(dist, name), { throwIfNoEntry: false })?.isFile()) out.push(`${name} is missing`);
  }
  return out;
}

/**
 * A minimal MCP client over the stdio relay (`bogen mcp`): newline-delimited JSON-RPC. `call` resolves with the
 * tool's structured content (or its text parsed as JSON, or the text), and rejects on a tool error.
 */
export function mcpStdio(command, args, { env, timeoutMs = 120_000 } = {}) {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = '';
  let next = 1;
  const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const w = msg.id !== undefined ? waiting.get(msg.id) : undefined;
      if (!w) continue;
      waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.error) w.reject(new Error(`${w.what}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else w.resolve(msg.result);
    }
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  void exited.then((code) => {
    for (const w of waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new Error(`${w.what}: bogen mcp exited (${code})`));
    }
    waiting.clear();
  });
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const request = (method, params, what = method) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`${what}: no answer within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    waiting.set(id, { resolve, reject, timer, what });
    send({ jsonrpc: '2.0', id, method, params });
  });
  let ready = null;
  const init = () => (ready ??= request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bogen-verify-app', version: '1' } })
    .then(() => send({ jsonrpc: '2.0', method: 'notifications/initialized' })));
  return {
    async call(name, args = {}) {
      await init();
      const result = await request('tools/call', { name, arguments: args }, name);
      const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (result.isError) throw new Error(`${name}: ${text.slice(0, 500)}`);
      if (result.structuredContent) return result.structuredContent;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    async close() {
      child.stdin.end();
      const t = setTimeout(() => child.kill('SIGTERM'), 5_000);
      await exited;
      clearTimeout(t);
    },
    pid: child.pid,
  };
}

const json = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

/**
 * Drives the engine features that read files or run WebAssembly and axe-core: an icon set beyond Lucide, a font
 * build to WOFF2, and an accessibility check in the headless shell. `must(cond, what)` throws on a failed check.
 */
export async function engineChecks(call, must) {
  const icons = await call('icon_search', { query: 'home', set: 'tabler', limit: 3 });
  must(/tabler:/.test(json(icons)), 'icon_search reads the Tabler set from server/dist/icon-sets');

  const file = await call('file_create', { name: 'Bundle check' });
  const fileId = file.id;
  must(typeof fileId === 'string' && fileId.length > 0, 'file_create makes a scratch file');
  await call('font_create', { family: 'Bundle Check', file_id: fileId });
  // A stem from the ascender line to the baseline (cell coordinates: y down from the ascender, baseline at 800).
  await call('font_glyphs_set', { file_id: fileId, glyphs: [{ char: 'I', advance: 300, d: 'M100 100 H200 V800 H100 Z' }] });
  const font = await call('font_build', { file_id: fileId });
  must(/\.woff2$/.test(String(font?.woff2 ?? '')) && Number(font?.woff2_kb) > 0, 'font_build writes a WOFF2 (woff2-encoder WebAssembly)');

  // A page of its own, so the check reads this screen rather than the glyph page font_create made current.
  const page = await call('page_create', { name: 'Check', file_id: fileId });
  const pageId = page.id ?? page.page_id;
  const board = await call('artboard_create', { name: 'Check', width: 390, file_id: fileId, ...(pageId ? { page_id: pageId } : {}) });
  await call('html_write', { file_id: fileId, target_id: board.id, html: '<main lang="en" style="padding:24px;background:#fff;color:#111"><h1>Opening hours</h1><p>Monday to Friday, 9 to 17.</p></main>' });
  const report = await call('compliance_check', { file_id: fileId, profile: 'wcag-2.2-aa', node_id: board.id });
  const axe = report?.engines?.axe;
  must(typeof axe === 'string' && /^\d+\.\d+/.test(axe), `compliance_check runs axe-core ${axe ?? '(did not run)'} in the bundled headless shell`);

  const script = await call('script_run', { file_id: fileId, dry_run: true, code: 'return { pages: bogen.pages().length, node: typeof process };' });
  must(script?.result?.pages >= 1 && script?.result?.node === 'undefined', 'script_run runs a script in the bundled QuickJS sandbox, without Node');
  const pdf = await call('pdf_import', { file_id: fileId, data_base64: smokePdf('Bundle check').toString('base64') });
  must(pdf?.report?.[0]?.text === 1 && String(pdf?.tree ?? '').includes('Bundle check'), 'pdf_import reads a PDF with pdf.js from server/dist/vendor');
  const diagram = await call('diagram_insert', { file_id: fileId, source: 'flowchart LR\n  A[Bundled] --> B[Checked]' });
  must(diagram?.counts?.nodes === 2 && diagram?.counts?.connectors === 1, 'diagram_insert lays out Mermaid from server/dist/vendor in the bundled headless shell');
  return fileId;
}

/** A one-page PDF with one line of Helvetica text, for pdf_import. */
function smokePdf(line) {
  const stream = `BT /F1 24 Tf 72 720 Td (${line}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((o, i) => {
    const at = body.length;
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
