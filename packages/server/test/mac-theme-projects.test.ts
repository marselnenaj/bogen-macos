import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branchContent, currentBranchId, listRevisions, MAIN_BRANCH } from '@bogen/core';
import { prepareRunIntent } from '../src/run-intent.ts';
import { setMacHostForTests } from '../src/http/mac-routes.ts';
import { MAC_FILE_SUFFIX } from '../src/mac-theme-projects.ts';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

/**
 * One Mac theme is one project file: repeat and concurrent requests reuse it, ambiguous ones (several files, or no
 * name beside existing themes) are the person's choice, only new_project makes a separate theme, and branches inside
 * the file never rename the project. Fixtures only: no browser (the renderer is never asked), no system settings.
 */
describe('Mac theme projects', () => {
  let h: Harness;
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const create = async (body: Record<string, unknown>) => {
    const res = await fetch(`${h.base}/api/mac/themes`, json('POST', body));
    return { status: res.status, body: await res.json() };
  };
  const macFiles = () => h.server.storage.list().filter((e) => e.name.endsWith(MAC_FILE_SUFFIX));
  const count = () => h.server.storage.list().length;

  beforeAll(async () => {
    h = await startServer();
    setMacHostForTests(h.server, 'macos');
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it('reuses the one project of a name and scopes, over HTTP and for agents, and makes nothing more', async () => {
    const first = await create({ name: 'Dusk Glass', displays: ['studio-display'] });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ name: 'Dusk Glass', scopes: ['desktop', 'app'], branch: { id: 'main', name: 'Main' } });
    expect(first.body.project_id).toMatch(/^[0-9a-z]{4,40}$/);
    const before = count();
    const again = await create({ name: 'Dusk Glass' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ file_id: first.body.file_id, reused: true, project_id: first.body.project_id, boards: [] });
    expect(again.body.next).toContain('design_branch_create');
    // A name is matched as a theme name, not a byte string.
    expect((await create({ name: '  dusk   glass ' })).body).toMatchObject({ file_id: first.body.file_id, reused: true });
    const agent = await connectAgent(h.base, 'Claude Code');
    try {
      const out = await call(agent, 'mac_theme_create', { name: 'Dusk Glass' });
      expect(out).toMatchObject({ file_id: first.body.file_id, reused: true });
      expect(out.note).toMatch(/Nothing is applied to the Mac/);
      // The session continues in the reused file.
      await call(agent, 'tokens_set', { tokens: [{ name: 'probe-mac', kind: 'color', value: '#123456' }] });
      expect((await h.server.rooms.get(first.body.file_id)).doc.getTokens().some((t) => t.name === 'probe-mac')).toBe(true);
    } finally {
      await agent.close();
    }
    expect(count()).toBe(before);
  });

  it('makes one file for the same request sent several times at once', async () => {
    const before = count();
    const results = await Promise.all([1, 2, 3, 4].map(() => create({ name: 'Paper Night', scopes: ['desktop'], displays: ['macbook-air-13'] })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200 && r.body.reused)).toHaveLength(3);
    expect(new Set(results.map((r) => r.body.file_id)).size).toBe(1);
    expect(count()).toBe(before + 1);
  });

  it('keeps scopes apart: the same name for the desktop only is another theme', async () => {
    const desk = await create({ name: 'Dusk Glass', scopes: ['desktop'], displays: ['imac-24'] });
    expect(desk.status).toBe(201);
    const kit = await create({ name: 'Dusk Glass', scopes: ['app'] });
    expect(kit.status).toBe(201);
    expect(new Set([desk.body.file_id, kit.body.file_id]).size).toBe(2);
    expect((await create({ name: 'Dusk Glass', scopes: ['app'] })).body).toMatchObject({ file_id: kit.body.file_id, reused: true });
  });

  it('asks for a choice among legacy duplicates and an unnamed request, continues by file_id, and makes nothing', async () => {
    const dupes: string[] = [];
    for (const extra of [{ new_project: true }, { new_project: true }, { copy: true }]) {
      const made = await create({ name: 'Old Fern', scopes: ['app'], ...extra });
      expect(made.status).toBe(201);
      dupes.push(made.body.file_id);
    }
    expect(new Set(dupes).size).toBe(3);
    // One of them is from before projects and the index: no project id, no index entry, not loaded.
    const legacy = dupes[0]!;
    const room = await h.server.rooms.get(legacy);
    const { project: _project, ...old } = room.doc.meta.get('macTheme') as Record<string, unknown>;
    room.doc.transact(() => room.doc.meta.set('macTheme', old), 'test');
    await h.server.rooms.unload(legacy);
    h.server.storage.update(legacy, { macTheme: undefined });
    const before = count();
    const http = await create({ name: 'Old Fern', scopes: ['app'] });
    expect(http.status).toBe(409);
    expect(http.body.needs_choice).toBe(true);
    expect(http.body.choose.map((c: { file_id: string }) => c.file_id).sort()).toEqual([...dupes].sort());
    expect(http.body.message).toContain('Nothing was made');
    // The legacy file was read once, without a room, and indexed for good.
    expect(h.server.storage.get(legacy)!.macTheme).toMatchObject({ name: 'Old Fern', scopes: ['app'], branch: 'main' });
    expect(h.server.storage.get(legacy)!.macTheme!.project).toBeUndefined();
    const agent = await connectAgent(h.base, 'Codex');
    try {
      const out = await call(agent, 'mac_theme_create', { name: 'Old Fern', scopes: ['app'] });
      expect(out.needs_choice).toBe(true);
      expect(out.candidates).toHaveLength(3);
      expect(out.next).toContain('new_project');
      expect(out.next).toContain('Never pick the newest');
      // An explicit file id continues that one, legacy or not.
      expect(await call(agent, 'mac_theme_create', { file_id: legacy })).toMatchObject({ file_id: legacy, reused: true, name: 'Old Fern' });
      // No name beside existing Mac themes of those scopes is a choice too.
      const vague = await call(agent, 'mac_theme_create', { scopes: ['app'] });
      expect(vague.needs_choice).toBe(true);
      expect(vague.candidates.map((c: { file_id: string }) => c.file_id)).toEqual(expect.arrayContaining(dupes));
    } finally {
      await agent.close();
    }
    expect(count()).toBe(before);
  });

  it('makes a separate theme only on purpose: Home\'s New, new_project or copy', async () => {
    const before = macFiles().length;
    // Home's New buttons send new_project: Bogen names the second one apart, never a second "New Mac theme".
    const a = await create({ new_project: true, scopes: ['desktop'], displays: ['macbook-pro-16'] });
    const b = await create({ new_project: true, scopes: ['desktop'], displays: ['macbook-pro-16'] });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.file_id).not.toBe(b.body.file_id);
    expect(a.body.project_id).not.toBe(b.body.project_id);
    expect(new Set([a.body.name, b.body.name]).size).toBe(2);
    expect([a.body.name, b.body.name]).toContain('New Mac theme');
    expect(macFiles().length).toBe(before + 2);
    // A deliberate copy under a taken name is allowed and is its own project.
    const copy = await create({ name: 'Dusk Glass', new_project: true });
    expect(copy.status).toBe(201);
    // From then on the name is ambiguous: the person picks.
    expect((await create({ name: 'Dusk Glass' })).status).toBe(409);
  });

  it('refuses a file that is not a Mac theme as file_id, and leaves no half-made file when making one fails', async () => {
    const agent = await connectAgent(h.base, 'Claude Code');
    try {
      const plain = await call(agent, 'file_create', { name: 'Not a theme' });
      expect((await create({ file_id: plain.id })).status).toBe(422);
    } finally {
      await agent.close();
    }
    const omarchy = h.server.createFile('Tokyo · Omarchy theme');
    const room = await h.server.rooms.get(omarchy.id);
    room.doc.transact(() => room.doc.meta.set('omarchyTheme', { name: 'Tokyo', format: 2, target: 'desktop' }), 'test');
    const refused = await create({ file_id: omarchy.id });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatch(/Omarchy theme for Omarchy Linux, not a Mac theme/);
    expect(room.doc.meta.get('macTheme')).toBeUndefined();
    const before = count();
    expect((await create({ name: 'Broken Displays', new_project: true, displays: ['no-such-display'] })).status).toBe(400);
    expect(count()).toBe(before);
    expect(macFiles().some((e) => e.name.startsWith('Broken Displays'))).toBe(false);
  });

  it('refuses file_create in an edit run of a Mac theme and for a Mac theme file name; New on Home still makes one', async () => {
    const made = await create({ name: 'Quiet Bay', scopes: ['desktop'], displays: ['macbook-air-15'] });
    const fileId = made.body.file_id as string;
    // An edit run of this Mac theme, as the server records one when the person asks to change it.
    (h.server.runs as unknown as { runs: Map<string, unknown> }).runs.set('macedit1', { fileId, intent: 'edit' });
    const before = count();
    const run = await connectAgent(h.base, 'Claude Code', { 'x-bogen-run': 'macedit1', 'x-bogen-file': fileId });
    try {
      const refused = await callRaw(run, 'file_create', { name: 'Quiet Bay v2' });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toMatch(/change a Mac theme, which lives in one file with its branches/);
      expect(refused.content[0]!.text).toContain('design_branch_create');
    } finally {
      await run.close();
      (h.server.runs as unknown as { runs: Map<string, unknown> }).runs.delete('macedit1');
    }
    // Outside a run, a plain file named like a Mac theme file is refused too, pointing at mac_theme_create.
    const agent = await connectAgent(h.base, 'Codex');
    try {
      for (const name of ['Quiet Bay · Mac theme', 'Another one · mac theme ']) {
        const named = await callRaw(agent, 'file_create', { name });
        expect(named.isError).toBe(true);
        expect(named.content[0]!.text).toMatch(/mac_theme_create/);
        expect(named.content[0]!.text).toContain('new_project: true');
      }
      expect(count()).toBe(before);
      // Other designs are still made as before.
      expect((await call(agent, 'file_create', { name: 'Logo ideas' })).id).toBeTruthy();
      // An explicit separate theme still works, for agents and for Home's New.
      const separate = await call(agent, 'mac_theme_create', { name: 'Quiet Bay', scopes: ['desktop'], new_project: true });
      expect(separate.reused).toBeUndefined();
      expect(separate.file_id).not.toBe(fileId);
    } finally {
      await agent.close();
    }
    expect((await create({ new_project: true, scopes: ['app'] })).status).toBe(201);
    expect(count()).toBe(before + 3);
  });

  it('makes no new Mac theme file from a bound run, a revision or a branch, under any name; reuse and explicit separate themes still work', async () => {
    const outside = await connectAgent(h.base, 'Claude Code');
    const foo = await call(outside, 'mac_theme_create', { name: 'Foo', scopes: ['app'] });
    expect(foo.reused).toBeUndefined();
    await outside.close();
    const before = count();
    const runs = (h.server.runs as unknown as { runs: Map<string, unknown> }).runs;
    for (const intent of ['edit', 'revise'] as const) {
      runs.set(`macguard${intent}`, { fileId: foo.file_id, intent });
      const run = await connectAgent(h.base, 'Claude Code', { 'x-bogen-run': `macguard${intent}`, 'x-bogen-file': foo.file_id });
      try {
        for (const args of [{ name: 'Foo v2', scopes: ['app'] }, { name: 'Foo-v2', scopes: ['app'], new_project: true }, { name: 'Foo desk', scopes: ['desktop'], copy: true }]) {
          const refused = await callRaw(run, 'mac_theme_create', args);
          expect(refused.isError).toBe(true);
          expect(refused.content[0]!.text).toMatch(intent === 'edit' ? /asked to change existing work/ : /asked to redo existing work/);
          expect(refused.content[0]!.text).toContain('mac_theme_create makes no new theme file');
        }
        expect(await call(run, 'mac_theme_create', { name: 'Foo', scopes: ['app'] })).toMatchObject({ file_id: foo.file_id, reused: true });
      } finally {
        await run.close();
        runs.delete(`macguard${intent}`);
      }
    }
    expect(count()).toBe(before);

    // An outside session on a branch of Foo: no new file, while Foo reopens on that branch.
    const branched = await connectAgent(h.base, 'Codex');
    try {
      await call(branched, 'mac_theme_create', { file_id: foo.file_id });
      await call(branched, 'design_branch_create', { name: 'Brighter' });
      const refused = await callRaw(branched, 'mac_theme_create', { name: 'Foo-v2', scopes: ['app'], new_project: true });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toMatch(/works in a branch of its file/);
      expect(await call(branched, 'mac_theme_create', { name: 'Foo', scopes: ['app'] })).toMatchObject({ file_id: foo.file_id, reused: true, branch: { name: 'Brighter' } });
      await call(branched, 'design_branch_switch', { branch_id: 'main' });
    } finally {
      await branched.close();
    }
    expect(count()).toBe(before);

    // On main, a session working on Foo makes another Mac theme only when asked for a separate one.
    const onMain = await connectAgent(h.base, 'Codex');
    try {
      await call(onMain, 'mac_theme_create', { file_id: foo.file_id });
      const vague = await callRaw(onMain, 'mac_theme_create', { name: 'Foo v2', scopes: ['app'] });
      expect(vague.isError).toBe(true);
      expect(vague.content[0]!.text).toMatch(/is working on a Mac theme, Foo · Mac theme/);
      expect(vague.content[0]!.text).toContain('new_project: true');
      expect(count()).toBe(before);
      expect((await call(onMain, 'mac_theme_create', { name: 'Foo v2', scopes: ['app'], new_project: true })).file_id).not.toBe(foo.file_id);
    } finally {
      await onMain.close();
    }
    const fresh = await connectAgent(h.base, 'Codex');
    try {
      expect((await call(fresh, 'mac_theme_create', { name: 'Unbound Mac', scopes: ['app'] })).reused).toBeUndefined();
    } finally {
      await fresh.close();
    }
    // Home's New over HTTP is the person's deliberate ask.
    expect((await create({ new_project: true, scopes: ['app'] })).status).toBe(201);
    expect(count()).toBe(before + 3);
  });

  it('file_create stays refused in an edit run of a Mac theme whose room was unloaded, and after a session bound one', async () => {
    const runs = (h.server.runs as unknown as { runs: Map<string, unknown> }).runs;
    const made = await create({ name: 'Cold Mac Edit', scopes: ['app'] });
    await h.server.rooms.unload(made.body.file_id);
    runs.set('coldmacedit', { fileId: made.body.file_id, intent: 'edit', touched: new Set(), touchedFiles: new Map() });
    const before = count();
    const edit = await connectAgent(h.base, 'Claude Code', { 'x-bogen-run': 'coldmacedit' });
    try {
      expect(h.server.rooms.peek(made.body.file_id)).toBeUndefined();
      const out = await callRaw(edit, 'file_create', { name: 'Neutral notes' });
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/asked to change a Mac theme/);
    } finally {
      await edit.close();
      runs.delete('coldmacedit');
    }
    expect(count()).toBe(before);
    // An edit run on a plain page whose session then made a Mac theme.
    const page = h.server.createFile('Plain Mac run page');
    runs.set('plainmacrun', { fileId: page.id, intent: 'edit', touched: new Set(), touchedFiles: new Map() });
    const mixed = await connectAgent(h.base, 'Claude Code', { 'x-bogen-run': 'plainmacrun', 'x-bogen-file': page.id });
    try {
      expect((await call(mixed, 'mac_theme_create', { name: 'Bound Since Mac', scopes: ['app'] })).reused).toBeUndefined();
      const out = await callRaw(mixed, 'file_create', { name: 'Neutral notes' });
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/asked to change a Mac theme/);
    } finally {
      await mixed.close();
      runs.delete('plainmacrun');
    }
    expect(count()).toBe(before + 2);
  });

  it('redoes a Mac theme in a branch of its file, never as artboard revisions, and leaves main\'s palette alone', async () => {
    const made = await create({ name: 'Redo Me', scopes: ['desktop'], displays: ['macbook-air-13'] });
    const id = made.body.file_id as string;
    const room = await h.server.rooms.get(id);
    const accent = () => room.doc.getTokens().find((t) => t.name === 'mac-accent')!.value;
    const before = accent();
    const files = count();
    const req = await prepareRunIntent(h.server, { fileId: id, runner: 'claude', prompt: 'Redo it with warmer colours', conversationId: 'mac-redo-1' } as never);
    expect(req.intent).toBe('revise');
    expect(req.branch).toMatchObject({ reused: false });
    expect(req.revision).toBeUndefined();
    expect(listRevisions(room.doc)).toHaveLength(0);
    expect(currentBranchId(room.doc)).toBe(req.branch!.id);
    // The redo changes the branch's palette; main keeps its own.
    room.doc.transact(() => room.doc.setToken('mac-accent', 'color', '#ff5500'), 'test');
    const main = branchContent(room.doc, MAIN_BRANCH).tokens.find((t: { name: string }) => t.name === 'mac-accent') as { value: string };
    expect(main.value).toBe(before);
    expect(count()).toBe(files);
    // The next message of the same conversation continues that branch.
    const again = await prepareRunIntent(h.server, { fileId: id, runner: 'claude', prompt: 'Redo it once more', conversationId: 'mac-redo-1' } as never);
    expect(again.branch).toMatchObject({ id: req.branch!.id, reused: true });
    expect(count()).toBe(files);
  });

  it('lists each Mac theme\'s compact record with the files, so Home shows its branches without loading it', async () => {
    const made = await create({ name: 'Signal Fog', scopes: ['app'] });
    const id = made.body.file_id as string;
    await fetch(`${h.base}/api/files/${id}/design-branches`, json('POST', { name: 'Cooler', by: 'person', checkout: false }));
    const files = await (await fetch(`${h.base}/api/files`)).json() as { id: string; macTheme?: { name: string; scopes: string[]; branch: string; branches: { name: string }[] }; theme?: unknown }[];
    const row = files.find((f) => f.id === id)!;
    expect(row.theme).toBeUndefined();
    expect(row.macTheme).toMatchObject({ name: 'Signal Fog', scopes: ['app'], branch: 'main' });
    expect(row.macTheme!.branches.map((b) => b.name)).toEqual(expect.arrayContaining(['Cooler']));
    expect(row.macTheme).toHaveProperty('project', made.body.project_id);
  });

  it('works with branches inside the file; a branch renaming its theme never renames the project or the file', async () => {
    const made = await create({ name: 'Harbor Light', scopes: ['desktop'], displays: ['studio-display'] });
    const id = made.body.file_id as string;
    const branches = `${h.base}/api/files/${id}/design-branches`;
    const started = await fetch(branches, json('POST', { name: 'Warmer', by: 'person' }));
    expect(started.status).toBe(201);
    const branchId = (await started.json()).branch.id as string;
    // The theme name on the branch is that version's.
    const patched = await fetch(`${h.base}/api/mac/theme/${id}`, json('PATCH', { name: 'Harbor Light Warm' }));
    expect(patched.status).toBe(200);
    expect((await patched.json()).theme.name).toBe('Harbor Light Warm');
    expect(h.server.storage.get(id)!.name).toBe('Harbor Light · Mac theme');
    expect(h.server.storage.get(id)!.macTheme).toMatchObject({ name: 'Harbor Light', branch: branchId, branchName: 'Warmer' });
    // Renaming the branch moves only the branch fields.
    expect((await fetch(`${branches}/${branchId}`, json('PATCH', { name: 'Warmer evening', by: 'person' }))).status).toBe(200);
    expect(h.server.storage.get(id)!.macTheme).toMatchObject({ name: 'Harbor Light', branchName: 'Warmer evening' });
    // The project is still found by its own name, on the branch that is checked out; the branch's name finds nothing.
    const again = await create({ name: 'Harbor Light', scopes: ['desktop'] });
    expect(again.body).toMatchObject({ file_id: id, reused: true, branch: { id: branchId, name: 'Warmer evening' } });
    expect((await create({ name: 'Harbor Light Warm', scopes: ['desktop'] })).status).toBe(201);
    // Agents can start a branch in a Mac theme, but merging and discarding stay the person's, in the editor.
    const agent = await connectAgent(h.base, 'Claude Code');
    try {
      const tools = (await agent.listTools()).tools.map((t) => t.name);
      expect(tools).toEqual(expect.arrayContaining(['design_branch_create', 'design_branch_list']));
      expect(tools.some((t) => /^design_branch_(merge|discard)/.test(t))).toBe(false);
      const listed = await call(agent, 'design_branch_list', { file_id: id });
      expect(JSON.stringify(listed)).toContain('Warmer evening');
    } finally {
      await agent.close();
    }
    // Back on main the theme reads its own name again.
    expect((await fetch(`${branches}/main/switch`, json('POST', { by: 'person' }))).status).toBe(200);
    expect((await (await fetch(`${h.base}/api/mac/theme/${id}`)).json()).theme.name).toBe('Harbor Light');
    expect(h.server.storage.get(id)!.macTheme).toMatchObject({ name: 'Harbor Light', branch: 'main' });
  });
});
