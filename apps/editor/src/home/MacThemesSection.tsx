import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { agentApi, type MacScope, type MacThemesState } from '../lib/agent-api.ts';
import { formatList } from '../i18n/format.ts';
import { useT } from '../i18n/react.ts';
import '../styles/mac-themes.css';

const OPEN_KEY = 'bogen-home-mac-themes';
/** The new theme's palette as the server starts it: sky, horizon, glow, ink, accent. */
const SWATCHES = ['#dce4f2', '#f3d8c7', '#ffb36e', '#3a4660', '#6e56cf'];

function storedOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * On a Mac, the theme a person makes is a Mac theme: their desktop (wallpapers for this Mac's displays, a light and
 * dark palette) and their own apps (an appearance kit), as two separate scopes. Elsewhere this shows nothing; a
 * Linux machine with Omarchy keeps Design an Omarchy theme.
 */
export function MacThemesSection() {
  const t = useT();
  const [data, setData] = useState<MacThemesState | null>(null);
  const [open, setOpen] = useState(storedOpen);
  const [making, setMaking] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    agentApi.macThemes().then(setData).catch(() => setData(null));
  }, []);
  if (data?.host !== 'macos') return null;
  const toggle = () => {
    setOpen(!open);
    try { localStorage.setItem(OPEN_KEY, open ? '0' : '1'); } catch { /* for this visit */ }
  };
  const make = (key: string, scopes: MacScope[]) => {
    setMaking(key);
    setFailed(null);
    // Home's New is the person asking for a separate new theme: never one of their existing themes reopened.
    void agentApi.createMacTheme({ scopes, new_project: true }).then((out) => { location.hash = `#/file/${out.file_id}`; }).catch((e: Error) => setFailed(e.message)).finally(() => setMaking(null));
  };
  // Display labels are names (from macOS, or Apple's model names), passed in as data.
  const wallpapers = data.displays.length
    ? t('Wallpapers for {displays}', { displays: formatList(data.displays.map((d) => d.label)) })
    : t('Wallpapers for a {display} until Bogen sees this Mac’s displays', { display: 'MacBook Pro 14″' });
  const rows: { key: string; scopes: MacScope[]; title: string; facts: string }[] = [
    { key: 'both', scopes: ['desktop', 'app'], title: t('New Mac theme'), facts: t('Your desktop and your own apps, light and dark') },
    { key: 'desktop', scopes: ['desktop'], title: t('Desktop appearance'), facts: wallpapers },
    { key: 'app', scopes: ['app'], title: t('App appearance kit'), facts: t('Semantic colours, type and spacing for apps you build') },
  ];
  return (
    <section className="examples omarchy-themes mac-themes" data-testid="mac-themes" aria-label={t('Design a Mac theme')}>
      <div className="brands-head">
        <button type="button" className="examples-toggle" onClick={toggle} aria-expanded={open} data-testid="mac-themes-toggle">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="brands-title">{t('Design a Mac theme')}</span>
        </button>
        {failed ? <span className="examples-error" role="alert">{failed}</span> : open ? <span className="omarchy-themes-hint">{t('Exported as files you set in System Settings. Bogen changes nothing on this Mac.')}</span> : null}
      </div>
      {open ? (
        <div className="example-list" role="list">
          {rows.map((r) => (
            <button key={r.key} type="button" role="listitem" className="example-row is-new" onClick={() => make(r.key, r.scopes)} disabled={making !== null} data-testid={`mac-theme-new-${r.key}`}>
              <span className="brand-swatches" aria-hidden="true">{SWATCHES.map((c) => <span key={c} style={{ background: c }} />)}</span>
              <span className="example-kind">{r.title}</span>
              <span className="brand-facts">{making === r.key ? t('Laying out the boards…') : r.facts}</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
