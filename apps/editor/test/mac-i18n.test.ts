import { readFileSync } from 'node:fs';
import { createElement, isValidElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { PLATFORMS, PROJECT_TYPES } from '@bogen/core';
import { extract, sourceCatalog } from '../../../scripts/i18n/extract.ts';
import { problems, SUPPLEMENT_PATH, type Supplement } from '../../../scripts/i18n/mac-supplement.ts';
import { makeTranslate } from '../src/i18n/core.ts';
import { MAC_ACCENT_WORDS, MAC_CAPABILITY_WORDS, MAC_STATUS_WORDS } from '../src/panels/mac-theme-words.ts';
import { MAC_CAPABILITIES, SYSTEM_ACCENTS } from '../../../packages/server/src/mac-theme.ts';

const x = extract();
const source = sourceCatalog(x.messages);

/** The Mac edition's editor files and the shared ones it changed for Mac hosts. */
const MAC_FILES = ['home/MacThemesSection.tsx', 'panels/MacTheme.tsx', 'panels/mac-theme-words.ts', 'home/OmarchyThemesSection.tsx', 'panels/OmarchyTheme.tsx', 'home/ProjectFilters.tsx', 'home/Home.tsx', 'ui/VoiceInput.tsx'];

const text = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return '';
};

describe('the Mac editor\'s words', () => {
  it('leave no English literal unwrapped in the Mac files', () => {
    expect(x.candidates.filter((c) => MAC_FILES.includes(c.file))).toEqual([]);
    expect(x.problems).toEqual([]);
  });

  it('declare every capability the server sends, word for word, as messages', () => {
    expect(Object.keys(MAC_CAPABILITY_WORDS).sort()).toEqual(MAC_CAPABILITIES.map((c) => c.id).sort());
    for (const c of MAC_CAPABILITIES) {
      expect(MAC_CAPABILITY_WORDS[c.id], c.id).toEqual({ title: c.title, detail: c.detail });
      expect(source[c.title], c.title).toBe(c.title);
      expect(source[c.detail], c.detail).toBe(c.detail);
    }
    for (const status of new Set(MAC_CAPABILITIES.map((c) => c.status))) expect(source[MAC_STATUS_WORDS[status]]).toBeDefined();
  });

  it('declare every System Settings accent the server can name', () => {
    expect(Object.keys(MAC_ACCENT_WORDS).sort()).toEqual(SYSTEM_ACCENTS.map((a) => a.id).sort());
    for (const a of SYSTEM_ACCENTS) {
      expect(MAC_ACCENT_WORDS[a.id]).toBe(a.label);
      expect(source[a.label]).toBe(a.label);
    }
  });

  it('declare the kinds of the Mac app: Mac themes, Omarchy themes and their platform words', () => {
    for (const k of PROJECT_TYPES) {
      expect(source[k.label], k.label).toBe(k.label);
      expect(source[k.one], k.one).toBe(k.one);
    }
    for (const p of PLATFORMS['mac-theme'] ?? []) expect(source[p.label], p.label).toBe(p.label);
    expect(PROJECT_TYPES.find((k) => k.type === 'omarchy-theme')).toMatchObject({ label: 'Omarchy themes', one: 'Omarchy theme' });
  });

  it('keep the Mac banners\' wording: an Omarchy theme on a Mac names Omarchy Linux', () => {
    const banner = readFileSync(new URL('../src/panels/OmarchyTheme.tsx', import.meta.url), 'utf8');
    expect(banner).toContain("remote ? t('Omarchy theme for Omarchy Linux') : t('Omarchy theme')");
    expect(source['Omarchy Mobile theme for {device}']).toBeDefined();
    // The shared wording stays for a host that runs Omarchy, so the shared catalogs keep those keys in use.
    expect(source['Mobile theme for {device}']).toBeDefined();
  });

  it('read as whole sentences in another language, names and numbers as data', () => {
    const fa = makeTranslate('fa', {
      'Mac theme {name}: desktop and your apps': 'پوستهٔ مک {name}: میز کار و برنامه‌های شما',
      '{display}: {width} × {height} pixels, native resolution': '{display}: {width} × {height} پیکسل، وضوح بومی',
    });
    expect(text(fa.rich('Mac theme {name}: desktop and your apps', { name: createElement('b', null, 'Dusk') }))).toBe('پوستهٔ مک Dusk: میز کار و برنامه‌های شما');
    // Persian digits, ungrouped, and the display's name isolated from the right-to-left sentence.
    expect(fa('{display}: {width} × {height} pixels, native resolution', { display: 'MacBook Pro 14″', width: 3024, height: 1964 })).toBe('⁨MacBook Pro 14″⁩: ۳۰۲۴ × ۱۹۶۴ پیکسل، وضوح بومی');
    // A capability the server rewords later shows its new English, never a stale translation.
    const de = makeTranslate('de', { 'Building an app': 'Eine App bauen' });
    expect(de('Building an app')).toBe('Eine App bauen');
    expect(de('Building a Mac app')).toBe('Building a Mac app');
  });
});

describe('the supplementary Mac inventory (scripts/i18n/mac-supplement.json)', () => {
  const supplement = JSON.parse(readFileSync(SUPPLEMENT_PATH, 'utf8')) as Supplement;

  it('describes this source exactly, against the shared snapshot it records', () => {
    expect(problems(supplement)).toEqual([]);
    expect(supplement.base.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('holds only messages the Mac files use', () => {
    for (const [key, m] of Object.entries(supplement.messages)) {
      expect(m.refs.length, key).toBeGreaterThan(0);
      expect(m.refs.every((r) => MAC_FILES.includes(r.replace(/:\d+$/, ''))), `${key}: ${m.refs.join(', ')}`).toBe(true);
    }
  });
});
