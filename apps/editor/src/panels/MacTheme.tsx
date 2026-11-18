import { useEffect, useState } from 'react';
import { Download, Monitor, X } from 'lucide-react';
import { agentApi, type MacThemeInfo } from '../lib/agent-api.ts';
import { downloadBlob } from '../lib/api.ts';
import { useTokens } from '../doc/hooks.ts';
import { useEditor } from '../state/store.ts';
import { ui, useUi } from '../state/ui.ts';
import { IconButton, Segmented, TextField } from '../ui/controls.tsx';
import { useT } from '../i18n/react.ts';
import { MAC_ACCENT_WORDS, MAC_STATUS_WORDS } from './mac-theme-words.ts';

/** The banner and the dialog each ask the server; a change made in one tells the other. */
const changed = new Set<() => void>();
const announce = () => { for (const fn of changed) fn(); };

/** What the server knows about the open file as a Mac theme. Undefined until it answered, null when it is not one. */
function useMacTheme(fileId: string | null): [MacThemeInfo | null | undefined, () => void] {
  const [info, setInfo] = useState<MacThemeInfo | null | undefined>(undefined);
  const [tick, setTick] = useState(0);
  // Token changes reach the server through sync a moment later; the accent the export names follows them.
  const tokens = useTokens();
  const [settled, setSettled] = useState(tokens);
  useEffect(() => {
    const t = setTimeout(() => setSettled(tokens), 600);
    return () => clearTimeout(t);
  }, [tokens]);
  useEffect(() => {
    if (!fileId) return setInfo(null);
    let live = true;
    void agentApi.macThemeInfo(fileId).then((r) => { if (live) setInfo(r.theme); }, () => { if (live) setInfo(null); });
    return () => { live = false; };
  }, [fileId, tick, settled]);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    changed.add(bump);
    return () => { changed.delete(bump); };
  }, []);
  return [info, announce];
}


/** A quiet line over the canvas of a Mac theme file. */
export function MacThemeBanner() {
  const t = useT();
  const fileId = useEditor((s) => s.fileId);
  const open = useUi((s) => s.macThemeOpen);
  const [info] = useMacTheme(fileId);
  if (!info) return null;
  const desktop = info.scopes.includes('desktop');
  const app = info.scopes.includes('app');
  return (
    <div className="banner banner-info omarchy-banner" role="status" data-testid="mac-theme-banner">
      <Monitor size={13} />
      <span>{t.rich(desktop && app ? 'Mac theme {name}: desktop and your apps' : app ? 'Mac theme {name}: your apps' : 'Mac theme {name}: desktop', { name: <b dir="auto">{info.name}</b> })}</span>
      <button type="button" className="btn btn-quiet" onClick={() => ui().set({ macThemeOpen: !open })} data-testid="mac-theme-open">{t('What it changes, export')}</button>
    </div>
  );
}

export function MacThemeDialog() {
  const open = useUi((s) => s.macThemeOpen);
  return open ? <Body /> : null;
}

function Body() {
  const t = useT();
  const fileId = useEditor((s) => s.fileId);
  const [info, refresh] = useMacTheme(fileId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const close = () => ui().set({ macThemeOpen: false });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (info === undefined) return null;
  const frame = (body: React.ReactNode) => (
    <div className="dialog-scrim" data-ui onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog settings omarchy-dialog" role="dialog" aria-modal="true" aria-label={t('Mac theme')} data-testid="mac-theme-dialog">
        <header className="dialog-head settings-head"><span className="settings-title">{t('Mac theme')}</span><IconButton icon={<X size={14} />} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={close} testId="mac-theme-close" /></header>
        <div className="settings-body">{body}</div>
      </div>
    </div>
  );
  if (!info) return frame(<p className="settings-hint omarchy-pad">{t('This file is not a Mac theme. Make one from Home, under Design a Mac theme.')}</p>);

  const patch = (p: { name?: string; appearance?: 'light' | 'dark' | 'auto' }) => {
    setError(null);
    void agentApi.updateMacTheme(fileId!, p).then(refresh, (e: Error) => setError(e.message));
  };
  const exportZip = () => {
    setBusy(true);
    setError(null);
    setNote(null);
    void agentApi.exportMacTheme(fileId!).then(({ blob, problems }) => {
      downloadBlob(blob, `${info.slug}-mac-theme.zip`);
      // The problems are the server's own sentences (board and token names in them), shown as they come.
      setNote(problems.length ? t('Exported, without: {problems}', { problems: problems.join(' ') }) : t('Exported. Set the wallpaper and appearance in System Settings, as the README in the folder says.'));
    }, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const desktop = info.scopes.includes('desktop');
  return frame(<>
    <div className="settings-row">
      <div><div className="settings-name">{t('Name')}</div><div className="settings-hint">{t.rich('Exports as {file}', { file: <code>{info.slug}-mac-theme.zip</code> })}</div></div>
      <div className="settings-control"><TextField value={info.name} onChange={(name) => patch({ name })} testId="mac-theme-name" /></div>
    </div>
    {desktop ? (
      <div className="settings-row">
        <div><div className="settings-name">{t('Designed for')}</div><div className="settings-hint">{t.rich('Accent nearest to System Settings’ {accent}. You choose both in System Settings › Appearance.', { accent: <b>{MAC_ACCENT_WORDS[info.accent.systemAccent] ? t(MAC_ACCENT_WORDS[info.accent.systemAccent]!) : info.accent.systemAccent}</b> })}</div></div>
        <div className="settings-control"><Segmented<'light' | 'dark' | 'auto'> value={info.appearance} onChange={(appearance) => patch({ appearance })} testId="mac-theme-appearance" options={[{ value: 'light', label: t('Light'), title: t('Light appearance') }, { value: 'dark', label: t('Dark'), title: t('Dark appearance') }, { value: 'auto', label: t('Auto'), title: t('A light and a dark wallpaper') }]} /></div>
      </div>
    ) : null}
    {desktop ? (
      <section className="omarchy-section" data-testid="mac-theme-displays">
        <div className="settings-name">{t('Displays')}</div>
        <ul className="omarchy-list">{info.displays.map((d) => {
          const vars = { display: d.label, width: d.width, height: d.height };
          return <li key={d.id}>{d.source === 'preset' ? t('{display}: {width} × {height} pixels, native resolution', vars) : d.source === 'this-mac' ? t('{display}: {width} × {height} pixels, as this Mac renders it now (backing pixels; a scaled resolution changes it)', vars) : t('{display}: {width} × {height} pixels, size as given', vars)}</li>;
        })}</ul>
      </section>
    ) : null}
    <section className="omarchy-section" data-testid="mac-theme-capabilities">
      <div className="settings-name">{t('What it changes')}</div>
      <dl className="omarchy-files">
        {/* Titles and details are the server's English, declared as messages in mac-theme-words.ts. */}
        {info.capabilities.map((c) => (
          <div key={c.id} data-capability={c.id} data-status={c.status} style={{ display: 'contents' }}>
            <dt>{t(c.title)}</dt>
            <dd className={c.status === 'preview-only' || c.status === 'not-offered' ? 'coverage-not-themable' : undefined}><b>{t(MAC_STATUS_WORDS[c.status] ?? c.status)}</b> · {t(c.detail)}</dd>
          </div>
        ))}
      </dl>
    </section>
    <section className="omarchy-section" data-testid="mac-theme-files">
      <div className="settings-name">{t('What the zip holds')}</div>
      <ul className="omarchy-list">{info.files.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
      <div className="settings-hint">{t('Data only: images, JSON, CSS and a README. Nothing in it runs, and Bogen changes nothing on this Mac.')}</div>
      <div className="omarchy-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={exportZip} data-testid="mac-theme-export"><Download size={13} /> {busy ? t('Rendering…') : t('Export')}</button>
      </div>
      {note ? <div className="settings-hint" role="status">{note}</div> : null}
      {error ? <div className="error" role="alert">{error}</div> : null}
    </section>
  </>);
}
