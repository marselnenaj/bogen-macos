/**
 * The Mac app's own interface messages: what the Mac edition's editor says beyond the shared (public) inventory it
 * merged, so translators can do just these once the shared catalogs are complete. Run with Node 22.18 or newer from
 * the repository root:
 *
 *   node scripts/i18n/mac-supplement.ts --write <git-ref> [--also <git-ref>…]
 *       writes scripts/i18n/mac-supplement.json: the messages of this source that are neither in the ref's
 *       source.json nor, for each --also ref, among the messages extracted from that commit's editor source (a
 *       shared feature merged here, such as the theme library), and the shared messages this source no longer uses
 *   node scripts/i18n/mac-supplement.ts --check             exits non-zero when the file no longer describes this source
 *
 * `<git-ref>` is the shared language branch as merged (the commit is recorded, so the file says which snapshot it
 * is relative to). Only the editor's words are here: the Mac app's native shell, menu bar icon and server-made text
 * are outside the editor's i18n.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract, sourceCatalog } from './extract.ts';

export const SUPPLEMENT_PATH = join(import.meta.dirname, 'mac-supplement.json');

type English = string | { one: string; other: string };
export interface Supplement {
  base: { ref: string; commit: string; messages: number };
  /** Shared features merged on top of the base: their own messages beyond it count as shared, not Mac. */
  also?: { ref: string; commit: string; messages: number }[];
  /** Messages the Mac editor adds, with the English and where they are used. */
  messages: Record<string, { en: English; refs: string[] }>;
  /** Shared messages this edition no longer shows (the Mac app names both kinds of theme), still in shared catalogs. */
  retired: string[];
}

export function build(base: Record<string, English>, ref: string, commit: string, also: { ref: string; commit: string; keys: string[] }[] = []): Supplement {
  const x = extract();
  const source = sourceCatalog(x.messages);
  const shared = new Set(Object.keys(base));
  const alsoOut: NonNullable<Supplement['also']> = [];
  for (const a of also) {
    const added = a.keys.filter((k) => !shared.has(k));
    for (const k of added) shared.add(k);
    alsoOut.push({ ref: a.ref, commit: a.commit, messages: added.length });
  }
  const messages: Supplement['messages'] = {};
  for (const key of Object.keys(source)) {
    if (shared.has(key)) continue;
    messages[key] = { en: source[key]!, refs: x.messages.get(key)!.refs };
  }
  return { base: { ref, commit, messages: Object.keys(base).length }, ...(alsoOut.length ? { also: alsoOut } : {}), messages, retired: [...shared].filter((k) => !(k in source)).sort() };
}

/** The messages a commit's own editor source has, extracted from a temporary copy of it (nothing here is written). */
function messagesAt(commit: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'bogen-mac-supplement-'));
  try {
    const tar = execFileSync('git', ['archive', '--format=tar', commit, 'apps/editor/src'], { maxBuffer: 1 << 30 });
    execFileSync('tar', ['-x', '-C', dir], { input: tar });
    return Object.keys(sourceCatalog(extract(join(dir, 'apps/editor/src')).messages));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What no longer matches between the file and this source; empty when it describes it exactly. */
export function problems(supplement: Supplement): string[] {
  const x = extract();
  const source = sourceCatalog(x.messages);
  const out: string[] = [];
  for (const [key, m] of Object.entries(supplement.messages)) {
    if (!(key in source)) out.push(`supplement message no longer in the source: ${JSON.stringify(key)}`);
    else if (JSON.stringify(source[key]) !== JSON.stringify(m.en)) out.push(`supplement message changed form: ${JSON.stringify(key)}`);
  }
  for (const key of supplement.retired) if (key in source) out.push(`retired message is used again: ${JSON.stringify(key)}`);
  const expected = supplement.base.messages + (supplement.also ?? []).reduce((n, a) => n + a.messages, 0) + Object.keys(supplement.messages).length - supplement.retired.length;
  const total = Object.keys(source).length;
  if (expected !== total) out.push(`the source has ${total} messages, the base and supplement account for ${expected}: run --write again`);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ref, ...rest] = process.argv.slice(2);
  if (command === '--write' && ref) {
    const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' });
    const commit = git('rev-parse', `${ref}^{commit}`).trim();
    const base = JSON.parse(git('show', `${commit}:apps/editor/src/i18n/source.json`)) as Record<string, English>;
    const alsoRefs: string[] = [];
    for (let i = 0; i < rest.length; i++) if (rest[i] === '--also' && rest[i + 1]) alsoRefs.push(rest[++i]!);
    const also = alsoRefs.map((r) => {
      const c = git('rev-parse', `${r}^{commit}`).trim();
      return { ref: r, commit: c, keys: messagesAt(c) };
    });
    const s = build(base, ref, commit, also);
    writeFileSync(SUPPLEMENT_PATH, JSON.stringify(s, null, 1) + '\n');
    const extra = (s.also ?? []).map((a) => ` + ${a.messages} from ${a.commit.slice(0, 7)}`).join('');
    console.log(`${Object.keys(s.messages).length} Mac messages over ${s.base.messages} shared (${commit.slice(0, 7)})${extra}; ${s.retired.length} shared messages retired.`);
  } else if (command === '--check') {
    const found = problems(JSON.parse(readFileSync(SUPPLEMENT_PATH, 'utf8')) as Supplement);
    for (const p of found) console.log(p);
    if (!found.length) console.log('The Mac supplement describes this source.');
    process.exit(found.length ? 1 : 0);
  } else {
    console.error('Usage: node scripts/i18n/mac-supplement.ts --write <git-ref> [--also <git-ref>…] | --check');
    process.exit(2);
  }
}
