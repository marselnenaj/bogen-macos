// The macOS menu bar, as data. main.ts turns it into an Electron Menu; tests check it without Electron.
//
// The editor handles ⌘Z, ⇧⌘Z, ⌘A and the zoom keys itself (Yjs undo per person, canvas selection, canvas zoom).
// A menu item that registered those accelerators would swallow the keystroke before the page saw it, so those items
// show their shortcut but do not register it (`registerAccelerator: false`), and a click sends the same keystroke to
// the page. Cut, copy and paste use the system roles: the editor listens for the DOM clipboard events they fire.
//
// File tabs belong to the editor (apps/editor/src/tabs/tab-keys.ts): Ctrl+Tab, ⌘1 to ⌘9 and ⌘W reach it as keys. The
// menu shows them without taking them, except ⌘W: the app takes that one, so that it closes the open file tab in the
// editor and closes the window only on Home with no file tab open (main.ts, closeTabOrWindow). A click on a tab item
// hands the editor the same key (`pageKey`). The Window menu lists the open file tabs, read from the editor (`EditorTabs`).

export type Command =
  | 'about' | 'settings' | 'check-updates' | 'new-design' | 'open' | 'save-copy' | 'home'
  | 'undo' | 'redo' | 'select-all' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'reload-editor'
  | 'show-logs' | 'show-data' | 'help' | 'acknowledgements' | 'install-cli'
  | 'close-tab' | 'next-tab' | 'previous-tab' | 'tab-at' | 'go-to-tab';

/** A key the editor's tab handler understands, as a click on a tab item hands it to the page. */
export interface PageKey { key: string; code: string; ctrl?: boolean; meta?: boolean; shift?: boolean }

/** The editor's open file tabs, as the Window menu lists them. `active` is the file in view, null for Home. */
export interface EditorTabs { tabs: { id: string; name: string }[]; active: string | null }

export interface Item {
  label?: string;
  role?: string;
  command?: Command;
  accelerator?: string;
  /** False: show the shortcut, leave the keystroke to the page. */
  registerAccelerator?: boolean;
  /** Keystroke a click sends to the page, for items that do not register their accelerator. */
  sendKey?: { key: string; modifiers: ('meta' | 'shift' | 'alt')[] };
  /** For tab items: the key a click hands to the editor page. */
  pageKey?: PageKey;
  /** For a file tab item: the file it opens. */
  fileId?: string;
  /** A tick in front: the tab in view. */
  checked?: boolean;
  submenu?: Item[];
  separator?: true;
  /** Only in development builds. */
  devOnly?: true;
}

const SEP: Item = { separator: true };

export function menuTemplate(appName = 'Bogen', tabs: EditorTabs | null = null): Item[] {
  return [
    {
      label: appName,
      submenu: [
        { label: `About ${appName}`, command: 'about' },
        { label: 'Check for Updates…', command: 'check-updates' },
        SEP,
        { label: 'Settings…', command: 'settings', accelerator: 'Command+,' },
        SEP,
        { role: 'services' },
        SEP,
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        SEP,
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Design', command: 'new-design', accelerator: 'Command+N' },
        { label: 'Open…', command: 'open', accelerator: 'Command+O' },
        SEP,
        { label: 'Save a Copy…', command: 'save-copy', accelerator: 'Shift+Command+S' },
        SEP,
        { label: 'All Designs', command: 'home' },
        SEP,
        { label: 'Close Tab', command: 'close-tab', accelerator: 'Command+W' },
        { label: 'Close Window', role: 'close', accelerator: 'Shift+Command+W' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', command: 'undo', accelerator: 'Command+Z', registerAccelerator: false, sendKey: { key: 'z', modifiers: ['meta'] } },
        { label: 'Redo', command: 'redo', accelerator: 'Shift+Command+Z', registerAccelerator: false, sendKey: { key: 'z', modifiers: ['meta', 'shift'] } },
        SEP,
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { label: 'Select All', command: 'select-all', accelerator: 'Command+A', registerAccelerator: false, sendKey: { key: 'a', modifiers: ['meta'] } },
        SEP,
        { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', command: 'zoom-in', accelerator: 'Command+=', registerAccelerator: false, sendKey: { key: '=', modifiers: ['meta'] } },
        { label: 'Zoom Out', command: 'zoom-out', accelerator: 'Command+-', registerAccelerator: false, sendKey: { key: '-', modifiers: ['meta'] } },
        { label: 'Actual Size', command: 'zoom-reset', accelerator: 'Command+0', registerAccelerator: false, sendKey: { key: '0', modifiers: ['meta'] } },
        SEP,
        { role: 'togglefullscreen' },
        SEP,
        // No shortcut: ⌘R and ⌥⌘R belong to the editor.
        { label: 'Reload Editor', command: 'reload-editor' },
        { role: 'toggleDevTools', devOnly: true },
      ],
    },
    { label: 'Window', role: 'window', submenu: windowMenu(tabs) },
    {
      role: 'help',
      submenu: [
        { label: `${appName} Help`, command: 'help' },
        { label: 'Install Command Line Tool…', command: 'install-cli' },
        SEP,
        { label: 'Show Data Folder in Finder', command: 'show-data' },
        { label: 'Show Logs in Finder', command: 'show-logs' },
        SEP,
        { label: 'Acknowledgements', command: 'acknowledgements' },
      ],
    },
  ];
}

const MAX_LISTED = 30;

/** The Window menu: the window commands, the tab commands, Home and every open file tab with ⌘1 to ⌘9. */
function windowMenu(tabs: EditorTabs | null): Item[] {
  const key = (n: number): Pick<Item, 'accelerator' | 'registerAccelerator' | 'pageKey'> =>
    ({ accelerator: `Command+${n}`, registerAccelerator: false, pageKey: { key: String(n), code: `Digit${n}`, meta: true } });
  const items: Item[] = [
    { role: 'minimize' },
    { role: 'zoom' },
    SEP,
    { label: 'Show Previous Tab', command: 'previous-tab', accelerator: 'Control+Shift+Tab', registerAccelerator: false, pageKey: { key: 'Tab', code: 'Tab', ctrl: true, shift: true } },
    { label: 'Show Next Tab', command: 'next-tab', accelerator: 'Control+Tab', registerAccelerator: false, pageKey: { key: 'Tab', code: 'Tab', ctrl: true } },
  ];
  if (tabs) {
    items.push(SEP, { label: 'All Designs', command: 'tab-at', checked: tabs.active === null, ...key(1) });
    // A very long list keeps its first tabs and the last one, which ⌘9 opens; the strip in the editor shows them all.
    const all = tabs.tabs.map((t, i) => ({ ...t, i }));
    const listed = all.length > MAX_LISTED ? [...all.slice(0, MAX_LISTED - 1), all.at(-1)!] : all;
    for (const t of listed) {
      // The editor's numbers: ⌘1 is Home, ⌘2 to ⌘8 a tab by place, ⌘9 always the last tab.
      const place = t.i + 2;
      const shortcut = place <= 8 ? key(place) : t.i === all.length - 1 ? key(9) : {};
      items.push({ label: tabLabel(t.name), command: 'go-to-tab', fileId: t.id, checked: tabs.active === t.id, ...shortcut });
    }
  }
  items.push(SEP, { role: 'front' });
  return items;
}

function tabLabel(name: string): string {
  const plain = name.replace(/\s+/g, ' ').trim();
  if (!plain) return 'Untitled';
  return plain.length > 60 ? `${plain.slice(0, 59)}…` : plain;
}

const TAB_ID = /^[\w-]{1,64}$/;

/**
 * The editor's tab list as it keeps it in localStorage ('bogen-tabs', apps/editor/src/tabs/tabs-state.ts), read
 * strictly: a JSON array of `{ id, name }`, ids in the editor's own form, no repeats, names cut to 200 characters.
 * Anything else gives no tabs.
 */
export function parseEditorTabs(raw: unknown, active: string | null): EditorTabs {
  const out: EditorTabs = { tabs: [], active: active && TAB_ID.test(active) ? active : null };
  if (typeof raw !== 'string' || raw.length > 200_000) return out;
  let list: unknown;
  try { list = JSON.parse(raw); } catch { return out; }
  if (!Array.isArray(list)) return out;
  const seen = new Set<string>();
  for (const t of list.slice(0, 500)) {
    if (!t || typeof t !== 'object') continue;
    const { id, name } = t as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || !TAB_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.tabs.push({ id, name: typeof name === 'string' ? name.slice(0, 200) : '' });
  }
  return out;
}

/** The file tab a hash in the editor shows, as the editor counts it: a full-screen preview is not a tab. */
export function tabOfHash(hash: string): string | null {
  if (/^#\/file\/[\w-]+\/preview/.test(hash)) return null;
  return /^#\/file\/([\w-]{1,64})(?:[/?]|$)/.exec(hash)?.[1] ?? null;
}

/**
 * One window per file: the editor window that shows a file already, among the app's windows (`url` is each one's
 * address; `editor` says whether it is the running server's editor). Null when none does. The file id is compared
 * as the editor compares it, without case.
 */
export function windowForFile<W extends { url: string }>(windows: readonly W[], fileId: string, editor: (url: string) => boolean): W | null {
  const want = fileId.toLowerCase();
  for (const w of windows) {
    if (!editor(w.url)) continue;
    const at = w.url.indexOf('#');
    if (at >= 0 && tabOfHash(w.url.slice(at))?.toLowerCase() === want) return w;
  }
  return null;
}

/** What ⌘W does: close the file tab in view, close the window (Home with no file tab, or a window of the app's own), or nothing. */
export function closeAction(editor: boolean, hash: string, tabs: EditorTabs | null): 'close-tab' | 'close-window' | 'none' {
  if (!editor) return 'close-window';
  if (tabOfHash(hash)) return 'close-tab';
  const home = hash === '' || hash === '#' || hash === '#/' || /^#\/(?:\?|$)/.test(hash);
  if (home && (!tabs || tabs.tabs.length === 0)) return 'close-window';
  return 'none';
}

/** Every accelerator that is registered with the system, for a check against the editor's own bindings. */
export function registeredAccelerators(items: Item[]): string[] {
  const out: string[] = [];
  const walk = (list: Item[]) => {
    for (const item of list) {
      if (item.accelerator && item.registerAccelerator !== false) out.push(item.accelerator);
      if (item.submenu) walk(item.submenu);
    }
  };
  walk(items);
  return out;
}
