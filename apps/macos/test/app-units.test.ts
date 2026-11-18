import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeFailure } from '../src/main/backend.ts';
import { IpcRefused, parseIpc } from '../src/main/ipc.ts';
import { importLegacy, legacyOffer } from '../src/main/legacy-import.ts';
import { knownDirs, mergePath, parseShellPath, shellPathCommand } from '../src/main/login-path.ts';
import { closeAction, menuTemplate, parseEditorTabs, registeredAccelerators, tabOfHash, windowForFile, type Item } from '../src/main/menu-template.ts';
import { bundleLayout, macPaths, withAppRuntimePolicy } from '../src/main/paths.ts';
import { decideNavigation, decidePermission, decideWindowOpen, externalUrl, isShellUrl, SHELL_CSP } from '../src/main/policy.ts';
import { LICENSE_NOTE, SOURCE_URL, TERMS } from '../src/main/product.ts';
import { isRecordedChild, parseEtime, parsePs, readChildren } from '../src/main/reaper.ts';
import { cliEnvText, DEFAULTS, loadSettings, parseSettings, saveSettings } from '../src/main/settings.ts';
import { restoreBounds } from '../src/main/window-state.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const dirs: string[] = [];
const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `bogen-app-${name}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('where the app keeps things', () => {
  it('uses Application Support, Caches and Logs of the person, never the Linux data folder', () => {
    const p = macPaths('/Users/ana');
    expect(p.data).toBe('/Users/ana/Library/Application Support/Bogen/data');
    expect(p.caches).toBe('/Users/ana/Library/Caches/Bogen');
    expect(p.logs).toBe('/Users/ana/Library/Logs/Bogen');
    expect(Object.entries(p).filter(([k]) => k !== 'legacyData').every(([, v]) => !v.includes('.local/share'))).toBe(true);
    const b = bundleLayout('/Applications/Bogen.app/Contents/Resources');
    expect(b.node).toBe('/Applications/Bogen.app/Contents/Resources/runtime/node/bin/node');
    expect(b.cli).toBe('/Applications/Bogen.app/Contents/Resources/server/dist/cli.js');
    expect(b.launcher).toBe('/Applications/Bogen.app/Contents/Resources/bin/bogen');
  });
});

describe('the backend environment', () => {
  it('keeps the person\'s environment and credentials, and forces the export browser sandbox on', () => {
    const env = withAppRuntimePolicy({ HOME: '/Users/ana', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-test', GITHUB_TOKEN: 'ghp_test', OPENAI_API_KEY: 'x', BOGEN_NO_SANDBOX: '1', NODE_OPTIONS: '--require /tmp/x.js', ELECTRON_RUN_AS_NODE: '1' });
    expect(env).toEqual({ HOME: '/Users/ana', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-test', GITHUB_TOKEN: 'ghp_test', OPENAI_API_KEY: 'x', BOGEN_NO_SANDBOX: '0' });
    expect(withAppRuntimePolicy({}).BOGEN_NO_SANDBOX).toBe('0');
  });

  it('the bundled launcher runs the bundled node with the app\'s home, port and the sandbox forced on, through a ~/.local/bin link', () => {
    const root = temp('launcher');
    const resources = join(root, 'Bogen.app', 'Contents', 'Resources');
    mkdirSync(join(resources, 'bin'), { recursive: true });
    mkdirSync(join(resources, 'runtime', 'node', 'bin'), { recursive: true });
    mkdirSync(join(resources, 'server', 'dist'), { recursive: true });
    copyFileSync(join(ROOT, 'apps', 'macos', 'resources', 'bin', 'bogen'), join(resources, 'bin', 'bogen'));
    chmodSync(join(resources, 'bin', 'bogen'), 0o755);
    // A stand-in node that prints what it was given.
    writeFileSync(join(resources, 'runtime', 'node', 'bin', 'node'), '#!/bin/sh\nprintf "%s\\n" "args=$*" "home=$BOGEN_HOME" "port=$BOGEN_PORT" "app=$BOGEN_MACOS_APP_ID" "self=$BOGEN_SELF_COMMAND" "nosandbox=$BOGEN_NO_SANDBOX" "nodeopts=${NODE_OPTIONS:-unset}" "token=$ANTHROPIC_API_KEY"\n');
    chmodSync(join(resources, 'runtime', 'node', 'bin', 'node'), 0o755);
    const home = join(root, 'home');
    const support = join(home, 'Library', 'Application Support', 'Bogen');
    mkdirSync(support, { recursive: true });
    writeFileSync(join(support, 'cli.env'), 'BOGEN_PORT=30123\nBOGEN_MACOS_APP_ID=dev.bogen.app\nNODE_OPTIONS=--require=/evil.js\nBOGEN_PORT=not-a-port\n');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    symlinkSync(join(resources, 'bin', 'bogen'), join(home, '.local', 'bin', 'bogen'));
    const out = execFileSync(join(home, '.local', 'bin', 'bogen'), ['mcp'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, BOGEN_NO_SANDBOX: '1', NODE_OPTIONS: '--inspect', ANTHROPIC_API_KEY: 'kept' } });
    // The launcher finds its bundle with `pwd -P`, the physical path: on macOS the temp folder /var/folders/… is
    // really /private/var/folders/…. Bundle paths are expected in that canonical form; HOME stays as it was given.
    const bundle = realpathSync(resources);
    expect(out.trim().split('\n')).toEqual([
      `args=${join(bundle, 'server', 'dist', 'cli.js')} mcp`, `home=${join(support, 'data')}`, 'port=30123', 'app=dev.bogen.app',
      `self=${join(bundle, 'bin', 'bogen')}`, 'nosandbox=0', 'nodeopts=unset', 'token=kept',
    ]);
  });
});

describe('what windows may load and ask for', () => {
  const port = 29990;
  it('keeps the editor on its exact origin and sends web links to the browser', () => {
    expect(decideNavigation('http://127.0.0.1:29990/#/file/abc', port)).toEqual({ action: 'allow' });
    expect(decideNavigation('http://127.0.0.1:29991/', port)).toEqual({ action: 'external', url: 'http://127.0.0.1:29991/' });
    expect(decideNavigation('http://localhost:29990/', port).action).toBe('external');
    expect(decideNavigation('https://example.com/a?b', port)).toEqual({ action: 'external', url: 'https://example.com/a?b' });
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'bogen-shell://app/index.html', 'smb://host/share', 'x-apple.systempreferences:', 'https://user:pw@example.com/']) {
      expect(decideNavigation(bad, port).action === 'allow' && !bad.startsWith('bogen-shell')).toBe(false);
      if (!bad.startsWith('bogen-shell')) expect(decideNavigation(bad, port)).toEqual({ action: 'deny' });
    }
    expect(decideWindowOpen('http://127.0.0.1:29990/#/preview/x', port)).toEqual({ action: 'child' });
    expect(decideWindowOpen('file:///Users/ana/.ssh/id_ed25519', port)).toEqual({ action: 'deny' });
    expect(externalUrl('mailto:hi@example.com')).toBe('mailto:hi@example.com');
  });

  it('grants the editor clipboard, fullscreen and notifications only, and nothing to any other origin', () => {
    expect(decidePermission('clipboard-read', 'http://127.0.0.1:29990/', port)).toBe(true);
    expect(decidePermission('clipboard-sanitized-write', 'http://127.0.0.1:29990/', port)).toBe(true);
    for (const p of ['media', 'geolocation', 'openExternal', 'hid', 'serial', 'usb', 'midiSysex', 'display-capture', 'pointerLock']) expect(decidePermission(p, 'http://127.0.0.1:29990/', port)).toBe(false);
    expect(decidePermission('clipboard-read', 'https://evil.example/', port)).toBe(false);
    expect(decidePermission('clipboard-read', 'http://127.0.0.1:29991/', port)).toBe(false);
  });

  it('grants the editor the microphone for speaking instead of typing, and never the camera', () => {
    expect(decidePermission('media', 'http://127.0.0.1:29990/', port, ['audio'])).toBe(true);
    expect(decidePermission('media', 'http://127.0.0.1:29990/#/file/abc', port, ['audio'])).toBe(true);
    for (const types of [[], ['video'], ['audio', 'video'], ['unknown']]) expect(decidePermission('media', 'http://127.0.0.1:29990/', port, types)).toBe(false);
    expect(decidePermission('media', 'https://evil.example/', port, ['audio'])).toBe(false);
    expect(decidePermission('media', 'http://127.0.0.1:29991/', port, ['audio'])).toBe(false);
    expect(decidePermission('media', 'bogen-shell://app/index.html', port, ['audio'])).toBe(false);
    expect(decidePermission('display-capture', 'http://127.0.0.1:29990/', port, ['audio'])).toBe(false);
  });

  it('recognises only bogen-shell://app as app-owned, with a CSP that runs no inline or remote script', () => {
    expect(isShellUrl('bogen-shell://app/index.html?view=error')).toBe(true);
    expect(isShellUrl('bogen-shell://evil/index.html')).toBe(false);
    expect(isShellUrl('http://127.0.0.1:29990/')).toBe(false);
    expect(SHELL_CSP).toContain("script-src 'self'");
    expect(SHELL_CSP).toContain("connect-src 'none'");
    expect(SHELL_CSP).not.toContain('unsafe');
  });
});

describe('IPC from app-owned pages', () => {
  const shell = 'bogen-shell://app/index.html?view=settings';
  it('accepts exact shapes from the top frame of an app page only', () => {
    expect(parseIpc('settings:set', { port: 30000 }, shell, true)).toEqual({ channel: 'settings:set', port: 30000 });
    expect(parseIpc('settings:connect-agent', { client: 'codex' }, shell, true)).toEqual({ channel: 'settings:connect-agent', client: 'codex' });
    expect(parseIpc('settings:connect-agent', { client: 'opencode' }, shell, true)).toEqual({ channel: 'settings:connect-agent', client: 'opencode' });
    expect(parseIpc('shell:state', undefined, shell, true)).toEqual({ channel: 'shell:state' });
  });

  it('refuses the editor, subframes, unknown channels, extra fields, odd values and commands', () => {
    const refuse = (fn: () => unknown) => expect(fn).toThrow(IpcRefused);
    refuse(() => parseIpc('shell:state', {}, 'http://127.0.0.1:29990/', true));
    refuse(() => parseIpc('shell:state', {}, shell, false));
    refuse(() => parseIpc('shell:exec', { cmd: 'rm -rf ~' }, shell, true));
    refuse(() => parseIpc('settings:connect-agent', { client: 'cursor; rm -rf ~' }, shell, true));
    refuse(() => parseIpc('settings:set', { port: 80 }, shell, true));
    refuse(() => parseIpc('settings:set', { port: '29990' }, shell, true));
    refuse(() => parseIpc('settings:set', { updateChecks: true, path: '/etc' }, shell, true));
    refuse(() => parseIpc('shell:quit', { now: true }, shell, true));
    refuse(() => parseIpc('shell:use-port', [29991], shell, true));
  });
});

describe('settings', () => {
  it('survive garbage, drop unknown keys, keep a sane window and write atomically', () => {
    expect(parseSettings(null)).toEqual(DEFAULTS);
    expect(parseSettings('{not json')).toEqual(DEFAULTS);
    expect(parseSettings(JSON.stringify({ port: 99999, updateChecks: 'yes', evil: 1, window: { x: 0, y: 0, width: 10, height: 10 } }))).toEqual(DEFAULTS);
    const ok = parseSettings(JSON.stringify({ port: 30001, updateChecks: false, window: { x: 10.4, y: 20, width: 1200, height: 800, maximized: true } }));
    expect(ok).toMatchObject({ port: 30001, updateChecks: false, window: { x: 10, y: 20, width: 1200, height: 800, maximized: true } });
    const dir = temp('settings');
    const file = join(dir, 'sub', 'settings.json');
    saveSettings(file, ok);
    expect(loadSettings(file)).toEqual(ok);
    expect(readdirSync(join(dir, 'sub'))).toEqual(['settings.json']);
  });

  it('writes a launcher environment with only a port and a bundle id', () => {
    expect(cliEnvText(29990, 'dev.bogen.app')).toBe('BOGEN_PORT=29990\nBOGEN_MACOS_APP_ID=dev.bogen.app\n');
    expect(() => cliEnvText(29990, 'dev.bogen.app\nNODE_OPTIONS=--require=/tmp/x')).toThrow();
    expect(() => cliEnvText(70000, 'dev.bogen.app')).toThrow();
  });
});

describe('finding claude and codex from a Dock launch', () => {
  it('asks the login shell between markers, ignoring banners, and refuses odd shells', () => {
    expect(shellPathCommand('/bin/zsh')).toEqual({ file: '/bin/zsh', args: ['-l', '-i', '-c', expect.stringContaining('"$PATH"')] });
    expect(shellPathCommand('/opt/homebrew/bin/fish')!.args.at(-1)).toContain('string join : $PATH');
    expect(shellPathCommand('zsh')).toBeNull();
    expect(shellPathCommand('/bin/zsh; rm -rf ~')).toBeNull();
    expect(shellPathCommand('/usr/bin/python3')).toBeNull();
    const out = 'Welcome back!\n\u001b[32m~\u001b[0m __BOGEN_PATH_START__/Users/ana/.nvm/versions/node/v24/bin:relative/bin:/opt/homebrew/bin__BOGEN_PATH_END__\n';
    expect(parseShellPath(out)).toEqual(['/Users/ana/.nvm/versions/node/v24/bin', '/opt/homebrew/bin']);
    expect(parseShellPath('no markers')).toEqual([]);
  });

  it('puts the shell PATH first, then known install folders that exist, then the system ones, without duplicates', () => {
    const home = '/Users/ana';
    const exists = (d: string) => d === '/Users/ana/.local/bin' || d === '/opt/homebrew/bin' || d === '/Users/ana/.claude/local';
    expect(mergePath(['/opt/homebrew/bin', '/usr/bin'], home, exists)).toBe('/opt/homebrew/bin:/usr/bin:/Users/ana/.local/bin:/Users/ana/.claude/local:/bin:/usr/sbin:/sbin');
    expect(knownDirs(home)).toContain('/Users/ana/.bun/bin');
  });
});

describe('the menu bar', () => {
  /** Every mod+ binding of the editor, read from its command registry, as an Electron accelerator. */
  function editorBindings(): Set<string> {
    const text = readFileSync(join(ROOT, 'apps/editor/src/commands/registry.ts'), 'utf8');
    const out = new Set<string>();
    for (const m of text.matchAll(/'(mod\+[^']+)'/g)) {
      const parts = m[1]!.split('+');
      const key = parts.at(-1)!.toUpperCase();
      const mods = new Set(parts.slice(0, -1));
      out.add([mods.has('shift') ? 'Shift' : '', mods.has('alt') ? 'Alt' : '', 'Command', key].filter(Boolean).join('+'));
    }
    return out;
  }

  it('registers no shortcut the editor handles itself but ⌘W, and shows ⌘Z, ⌘A and zoom without taking them', () => {
    const template = menuTemplate();
    const registered = registeredAccelerators(template).map((a) => a.toUpperCase());
    const editor = [...editorBindings()].map((a) => a.toUpperCase());
    // ⌘W is the one the app takes on purpose: it closes the editor's file tab, or the window on Home (closeAction).
    expect(registered.filter((a) => editor.includes(a))).toEqual(['COMMAND+W']);
    const flat: Item[] = [];
    const walk = (items: Item[]) => items.forEach((i) => { flat.push(i); if (i.submenu) walk(i.submenu); });
    walk(template);
    for (const command of ['undo', 'redo', 'select-all', 'zoom-in', 'zoom-out', 'zoom-reset']) {
      const item = flat.find((i) => i.command === command)!;
      expect(item.registerAccelerator).toBe(false);
      expect(item.sendKey).toBeDefined();
    }
    expect(flat.some((i) => i.role === 'copy') && flat.some((i) => i.role === 'paste') && flat.some((i) => i.role === 'cut')).toBe(true);
    expect(flat.find((i) => i.command === 'settings')?.accelerator).toBe('Command+,');
    expect(flat.find((i) => i.role === 'toggleDevTools')?.devOnly).toBe(true);
    expect(flat.find((i) => i.command === 'close-tab')?.accelerator).toBe('Command+W');
    expect(flat.find((i) => i.role === 'close')?.accelerator).toBe('Shift+Command+W');
  });

  const windowItems = (tabs: Parameters<typeof menuTemplate>[1]) => menuTemplate('Bogen', tabs).find((i) => i.role === 'window')!.submenu!;

  it('lists the editor\'s file tabs in the Window menu with the editor\'s ⌘1 to ⌘9, taking none of the keys', () => {
    const tabs = { tabs: Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, name: i === 3 ? '' : `File ${i}` })), active: 'f2' };
    const items = windowItems(tabs);
    const home = items.find((i) => i.label === 'All Designs')!;
    expect(home.accelerator).toBe('Command+1');
    expect(home.checked).toBe(false);
    const files = items.filter((i) => i.command === 'go-to-tab');
    expect(files.map((i) => i.fileId)).toEqual(tabs.tabs.map((t) => t.id));
    expect(files.map((i) => i.accelerator ?? null)).toEqual(['Command+2', 'Command+3', 'Command+4', 'Command+5', 'Command+6', 'Command+7', 'Command+8', null, null, 'Command+9']);
    expect(files.find((i) => i.checked)?.fileId).toBe('f2');
    expect(files[3]!.label).toBe('Untitled');
    for (const i of items) if (i.accelerator) expect(i.registerAccelerator).toBe(false);
    expect(items.find((i) => i.command === 'next-tab')).toMatchObject({ accelerator: 'Control+Tab', pageKey: { key: 'Tab', ctrl: true } });
    expect(items.find((i) => i.command === 'previous-tab')).toMatchObject({ accelerator: 'Control+Shift+Tab', pageKey: { key: 'Tab', ctrl: true, shift: true } });
    // Before the editor runs there are no tabs to list, only the tab commands.
    expect(windowItems(null).some((i) => i.command === 'go-to-tab' || i.label === 'All Designs')).toBe(false);
    // Three tabs: the last has ⌘4, as the editor counts it.
    expect(windowItems({ tabs: tabs.tabs.slice(0, 3), active: null }).filter((i) => i.command === 'go-to-tab').map((i) => i.accelerator)).toEqual(['Command+2', 'Command+3', 'Command+4']);
    // A very long list keeps its first tabs and the last one.
    const long = windowItems({ tabs: Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, name: 'x'.repeat(100) })), active: null }).filter((i) => i.command === 'go-to-tab');
    expect(long).toHaveLength(30);
    expect(long.at(-1)).toMatchObject({ fileId: 't49', accelerator: 'Command+9' });
    expect(long[0]!.label!.length).toBe(60);
  });

  it('reads the editor\'s tab list strictly', () => {
    expect(parseEditorTabs(JSON.stringify([{ id: 'a1', name: 'One' }, { id: 'a1', name: 'Again' }, { id: '../x', name: 'Bad' }, { id: 'b2' }, 7, null]), 'b2'))
      .toEqual({ tabs: [{ id: 'a1', name: 'One' }, { id: 'b2', name: '' }], active: 'b2' });
    expect(parseEditorTabs('not json', null)).toEqual({ tabs: [], active: null });
    expect(parseEditorTabs('{"id":"a"}', null).tabs).toEqual([]);
    expect(parseEditorTabs(null, '<script>')).toEqual({ tabs: [], active: null });
    expect(parseEditorTabs(JSON.stringify([{ id: 'a', name: 'n'.repeat(500) }]), null).tabs[0]!.name).toHaveLength(200);
  });

  it('finds the editor window that shows a file, so a second one is never opened for it', () => {
    const editor = (url: string) => url.startsWith('http://127.0.0.1:29990/');
    const wins = [
      { id: 1, url: 'http://127.0.0.1:29990/#/' },
      { id: 2, url: 'http://127.0.0.1:29990/#/file/abc123?layer=Title' },
      { id: 3, url: 'bogen-shell://app/index.html?view=settings#/file/zzz' },
      { id: 4, url: 'http://127.0.0.1:29990/#/file/def456/preview' },
    ];
    expect(windowForFile(wins, 'abc123', editor)?.id).toBe(2);
    expect(windowForFile(wins, 'ABC123', editor)?.id).toBe(2);
    expect(windowForFile(wins, 'zzz', editor)).toBe(null);
    expect(windowForFile(wins, 'def456', editor)).toBe(null);
  });

  it('closes the file tab on ⌘W, the window only on Home with no tab, and the app\'s own windows always', () => {
    expect(tabOfHash('#/file/abc')).toBe('abc');
    expect(tabOfHash('#/file/abc/preview')).toBe(null);
    expect(tabOfHash('#/file/abc?layer=x')).toBe('abc');
    expect(tabOfHash('#/')).toBe(null);
    const two = { tabs: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], active: 'a' };
    expect(closeAction(true, '#/file/a', two)).toBe('close-tab');
    expect(closeAction(true, '#/', two)).toBe('none');
    expect(closeAction(true, '#/', { tabs: [], active: null })).toBe('close-window');
    expect(closeAction(true, '', null)).toBe('close-window');
    expect(closeAction(true, '#/file/a/preview', two)).toBe('none');
    expect(closeAction(false, '', two)).toBe('close-window');
  });
});

describe('window restore', () => {
  const primary = { x: 0, y: 25, width: 1512, height: 920 };
  it('restores a frame on a current display, and recentres one from an unplugged display', () => {
    expect(restoreBounds({ x: 100, y: 100, width: 1200, height: 800 }, [primary], primary)).toMatchObject({ x: 100, y: 100, width: 1200, height: 800 });
    const gone = restoreBounds({ x: 3000, y: 100, width: 1200, height: 800 }, [primary], primary);
    expect(gone.x).toBeGreaterThanOrEqual(0);
    expect(gone.x + gone.width).toBeLessThanOrEqual(primary.width);
    expect(restoreBounds(undefined, [primary], primary).height).toBeLessThanOrEqual(primary.height);
  });
});

describe('importing designs of the script install', () => {
  it('offers only when the old folder has designs and the app has none, and copies without touching the original', async () => {
    const legacy = temp('legacy');
    const data = join(temp('data'), 'data');
    expect(await legacyOffer(legacy, data)).toBeNull();
    mkdirSync(join(legacy, 'files'));
    writeFileSync(join(legacy, 'index.json'), JSON.stringify({ files: [{ id: 'a', name: 'Poster' }] }));
    writeFileSync(join(legacy, 'files', 'a.ydoc'), 'doc');
    writeFileSync(join(legacy, 'server.json'), '{"pid":1}');
    expect(await legacyOffer(legacy, data)).toEqual({ from: legacy, files: 1 });
    await importLegacy(legacy, data);
    expect(readFileSync(join(data, 'files', 'a.ydoc'), 'utf8')).toBe('doc');
    expect(readdirSync(data).sort()).toEqual(['files', 'index.json']);
    expect(readFileSync(join(legacy, 'files', 'a.ydoc'), 'utf8')).toBe('doc');
    expect(await legacyOffer(legacy, data)).toBeNull();
  });
});

describe('reaper parsing', () => {
  it('reads ps etime in both BSD and procps forms and matches a child only by group and start time', () => {
    expect(parseEtime('00:07')).toBe(7);
    expect(parseEtime('01:02:03')).toBe(3723);
    expect(parseEtime('2-01:02:03')).toBe(2 * 86400 + 3723);
    expect(parseEtime('garbage')).toBeNull();
    const now = 1_000_000_000;
    expect(parsePs('  4242   00:10', now)).toEqual({ pgid: 4242, startedAt: now - 10_000 });
    const rec = { pid: 4242, startedAt: now - 10_500, kind: 'agent:claude' };
    expect(isRecordedChild(rec, { pgid: 4242, startedAt: now - 10_000 })).toBe(true);
    expect(isRecordedChild(rec, { pgid: 1, startedAt: now - 10_000 })).toBe(false);
    expect(isRecordedChild(rec, { pgid: 4242, startedAt: now - 60_000 })).toBe(false);
    expect(isRecordedChild(rec, null)).toBe(false);
    const dir = temp('children');
    writeFileSync(join(dir, 'children.json'), JSON.stringify({ children: [rec, { pid: 1, startedAt: 0, kind: 'x' }, { pid: 'x' }] }));
    expect(readChildren(join(dir, 'children.json'))).toEqual([rec]);
  });
});

describe('product truth', () => {
  it('says the app is free and open source, and asks for nothing', () => {
    expect(TERMS).toMatchObject({ model: 'free', license: 'GPL-3.0-or-later' });
    expect(TERMS.summary).toBe('Bogen for macOS is free and open source software under GPL-3.0-or-later.');
    expect(TERMS.source).toContain(SOURCE_URL);
    expect(`${TERMS.summary} ${TERMS.source} ${LICENSE_NOTE}`).not.toMatch(/price|purchas|USD|\$|trial|licen[cs]e key|activat|subscription|unlock/i);
    expect(LICENSE_NOTE).toContain('GNU General Public License, version 3 or later');
  });

  it('describes every backend failure with a way forward and no command to type into Terminal', () => {
    const all = [
      describeFailure({ code: 'port-other', port: 29990 }), describeFailure({ code: 'port-bogen', port: 29990, version: '0.1.0', pid: 12 }),
      describeFailure({ code: 'exited', exitCode: 1, signal: null, tail: 'boom' }), describeFailure({ code: 'timeout', seconds: 45, tail: '' }),
      describeFailure({ code: 'spawn', message: 'ENOENT' }), describeFailure({ code: 'crash-loop', restarts: 3, tail: 'x' }),
    ];
    for (const f of all) {
      expect(f.choices.length).toBeGreaterThan(0);
      expect(`${f.title} ${f.detail}`).not.toMatch(/systemctl|journalctl|sudo|kill -9/);
    }
  });
});
