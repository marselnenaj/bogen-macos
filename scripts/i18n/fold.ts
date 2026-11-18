/**
 * Folds validated supplementary translations into the canonical catalogs. Run with Node 22.18 or newer from the
 * repository root:
 *
 *   node scripts/i18n/fold.ts <dir> [--lang <code>…] [--check]
 *
 * <dir>/<code>.json holds translations keyed by the exact English source text (as the Mac supplement's validated
 * outputs are). For each language the catalog becomes, in source order: its own translation of a message where it has
 * one, else the supplement's. A shared value always wins over a supplement value, keys that are no longer messages of
 * the source (retired) are dropped, and nothing is ever filled with the English. Every value written is checked with
 * check.ts first; a language whose result breaks a rule is not written and is reported. --check writes nothing.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EDITOR_SRC, extract, sourceCatalog } from './extract.ts';
import { checkCatalog, FORMAT_LOCALES } from './check.ts';

type Value = string | Record<string, string>;
const LOCALES = join(EDITOR_SRC, 'i18n/locales');
const [dir, ...rest] = process.argv.slice(2);
if (!dir || dir.startsWith('--')) {
  console.error('Usage: node scripts/i18n/fold.ts <dir> [--lang <code>…] [--check]');
  process.exit(2);
}
const dryRun = rest.includes('--check');
const li = rest.indexOf('--lang');
const langs = li >= 0 ? rest.slice(li + 1).filter((a) => !a.startsWith('--')) : Object.keys(FORMAT_LOCALES);

const source = sourceCatalog(extract().messages);
let failed = 0;
for (const code of langs) {
  const path = join(LOCALES, `${code}.json`);
  const shared: Record<string, Value> = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const supPath = join(dir, `${code}.json`);
  const sup: Record<string, Value> = existsSync(supPath) ? JSON.parse(readFileSync(supPath, 'utf8')) : {};
  const out: Record<string, Value> = {};
  let fromShared = 0;
  let fromSup = 0;
  for (const key of Object.keys(source)) {
    if (key in shared) { out[key] = shared[key]!; fromShared++; } else if (key in sup) { out[key] = sup[key]!; fromSup++; }
  }
  const dropped = Object.keys(shared).filter((k) => !(k in source));
  const unusedSup = Object.keys(sup).filter((k) => !(k in source) || k in shared);
  const report = checkCatalog(code, out, source);
  const ok = !report.errors.length;
  if (ok && !dryRun) writeFileSync(path, JSON.stringify(out, null, 1) + '\n');
  if (!ok) failed++;
  console.log(`${code.padEnd(6)} ${ok ? 'ok' : 'FAIL'} shared ${fromShared} + supplement ${fromSup} = ${report.translated}/${Object.keys(source).length}, missing ${report.missing.length}, dropped ${dropped.length}${unusedSup.length ? `, supplement unused ${unusedSup.length}` : ''}${ok ? '' : `: ${report.errors.slice(0, 3).join('; ')}`}`);
}
process.exit(failed ? 1 : 0);
