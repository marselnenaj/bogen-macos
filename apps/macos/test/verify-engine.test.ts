// The engine checks verify-app.mjs runs on a built Bogen.app, run here against a staged copy of packages/server/dist:
// the same folder layout as Contents/Resources/server, outside the repository, so that the source tree's icon sets
// cannot stand in for missing ones. The functional part needs `npm run build` first and a Chromium-based browser
// (BOGEN_BROWSER or one on PATH), and listens on a loopback port.

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { engineChecks, expectedIconSets, mcpStdio, staticEngineProblems } from '../scripts/verify-engine.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const DIST = join(ROOT, 'packages', 'server', 'dist');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'bogen-verify-engine-'));
  dirs.push(d);
  return d;
};

function fakeDist(sets: Record<string, number>): string {
  const dist = join(temp(), 'dist');
  mkdirSync(join(dist, 'icon-sets'), { recursive: true });
  for (const d of ['editor', 'quickjs', 'vendor']) mkdirSync(join(dist, d), { recursive: true });
  for (const f of ['cli.js', 'vectorize-worker.js', 'shader-runtime.js', 'editor/index.html', 'script-worker.js', 'quickjs/quickjs-asyncify.wasm', 'vendor/mermaid.min.js', 'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs']) writeFileSync(join(dist, f), 'x');
  for (const [name, size] of Object.entries(sets)) writeFileSync(join(dist, 'icon-sets', name), 'x'.repeat(size));
  return dist;
}

describe('the static engine check of a bundle', () => {
  it('expects every icon set of this checkout', () => {
    expect(expectedIconSets(ROOT)).toEqual(expect.arrayContaining(['tabler.json', 'phosphor.json', 'heroicons.json', 'heroicons-solid.json', 'material-symbols.json']));
  });

  it('passes a complete dist and names what is missing or truncated', () => {
    const sets = ['phosphor.json', 'tabler.json'];
    expect(staticEngineProblems(fakeDist({ 'phosphor.json': 4096, 'tabler.json': 4096 }), sets)).toEqual([]);
    expect(staticEngineProblems(fakeDist({ 'phosphor.json': 4096 }), sets)).toEqual(['icon-sets/tabler.json is missing']);
    expect(staticEngineProblems(fakeDist({ 'phosphor.json': 4096, 'tabler.json': 10 }), sets)).toEqual(['icon-sets/tabler.json is only 10 bytes']);
    expect(staticEngineProblems(fakeDist({}), [])).toContain('no icon sets are expected: packages/core/src/icon-sets is empty');
  });

  it.skipIf(!existsSync(join(DIST, 'cli.js')))('passes the repository\'s own build', () => {
    expect(staticEngineProblems(DIST, expectedIconSets(ROOT))).toEqual([]);
  });
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as { port: number };
  await new Promise((r) => s.close(r));
  return port;
}

describe.skipIf(!existsSync(join(DIST, 'cli.js')))('the engine features of a staged server bundle', () => {
  it('reads icon sets beside cli.js, builds a WOFF2, runs axe-core, a script, a PDF and a diagram', async () => {
    const root = temp();
    const server = join(root, 'server');
    cpSync(DIST, join(server, 'dist'), { recursive: true });
    // The npm packages the bundle leaves external (puppeteer-core, esbuild), as package.mjs copies them.
    symlinkSync(join(ROOT, 'node_modules'), join(server, 'node_modules'));
    writeFileSync(join(server, 'package.json'), '{"name":"bogen-design","private":true,"type":"module"}\n');
    const port = await freePort();
    const env = { ...process.env, BOGEN_HOME: join(root, 'data'), BOGEN_PORT: String(port), BOGEN_WELCOME: '0', BOGEN_ICON_SETS_DIR: '' };
    const { spawn } = await import('node:child_process');
    const cli = join(server, 'dist', 'cli.js');
    const serve = spawn(process.execPath, [cli, 'serve'], { env, stdio: 'ignore' });
    const exited = new Promise((r) => serve.once('exit', r));
    const mcp = mcpStdio(process.execPath, [cli, 'mcp'], { env });
    const passed: string[] = [];
    try {
      for (let i = 0; i < 120; i++) {
        if (await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.ok, () => false)) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      await engineChecks((name: string, args: Record<string, unknown>) => mcp.call(name, args), (cond: boolean, what: string) => {
        if (!cond) throw new Error(`FAILED ${what}`);
        passed.push(what);
      });
    } finally {
      await mcp.close();
      serve.kill('SIGTERM');
      await exited;
    }
    expect(passed).toHaveLength(7);
  }, 180_000);
});
