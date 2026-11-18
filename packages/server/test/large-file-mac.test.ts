// A representative big file, not a demo: 30 screen-sized artboards (desktop, tablet and phone) of about 330 layers
// each, ~10,000 layers in all, with text, nested auto-layout frames and image references. What a Mac app must keep
// true for it, checked on any OS: it saves, reloads identically, survives a save that died half-way, an agent can
// edit it through MCP while it is open, and listing files does not load it.

import { readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { BogenDoc } from '@bogen/core';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

const SCREENS = [
  { name: 'Desktop', width: 1440, height: 900 },
  { name: 'Tablet', width: 834, height: 1194 },
  { name: 'Phone', width: 390, height: 844 },
];

/** Fills a page with `boards` artboards of ~330 layers each. Returns how many layers it made. */
function fill(doc: BogenDoc, pageId: string, boards: number): number {
  let count = 0;
  doc.y.transact(() => {
    for (let b = 0; b < boards; b++) {
      const screen = SCREENS[b % SCREENS.length]!;
      const board = doc.insert(pageId, { type: 'frame', name: `${screen.name} ${b + 1}`, artboard: true, style: { position: 'absolute', left: `${(b % 6) * 1600}px`, top: `${Math.floor(b / 6) * 1300}px`, width: `${screen.width}px`, height: `${screen.height}px`, backgroundColor: '#ffffff', display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px' } });
      count++;
      for (let s = 0; s < 18; s++) {
        const section = doc.insert(board, { type: 'frame', name: `Section ${s + 1}`, style: { display: 'flex', flexDirection: 'row', gap: '8px', padding: '8px', borderRadius: '8px', backgroundColor: s % 2 ? '#f4f2ec' : '#eef1ff' } });
        count++;
        for (let c = 0; c < 6; c++) {
          const card = doc.insert(section, { type: 'frame', name: `Card ${c + 1}`, style: { display: 'flex', flexDirection: 'column', gap: '4px', width: '160px' } });
          doc.insert(card, { type: 'text', name: 'Title', text: `Screen ${b + 1}, section ${s + 1}, card ${c + 1}`, style: { fontSize: '14px', fontWeight: '600', color: '#17151a' } });
          doc.insert(card, { type: 'image', name: 'Photo', src: `bogen-asset:${'0'.repeat(63)}${c}.png`, style: { width: '160px', height: '90px', objectFit: 'cover' } });
          count += 3;
        }
      }
    }
  });
  return count;
}

describe('a large multi-screen file', () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.cleanup(); h = undefined; });

  it('saves, reloads identically, survives an interrupted save, takes agent edits, and is not loaded to list files', async () => {
    h = await startServer({ thumbnails: false });
    const file = h.server.storage.create('Big app');
    const room = await h.server.rooms.get(file.id);
    const page = room.doc.getPages()[0]!.id;
    const t0 = Date.now();
    const made = fill(room.doc, page, 30);
    const buildMs = Date.now() - t0;
    expect(made).toBeGreaterThan(9500);
    const layers = room.doc.nodes.size;
    expect(layers).toBeGreaterThanOrEqual(made);

    // An agent edits it through MCP while it is open, as a run would.
    const agent = await connectAgent(h.base, 'claude');
    const board = room.doc.getChildren(page)[7]!;
    await call(agent, 'layer_rename', { file_id: file.id, node_id: board.id, name: 'Checkout' });
    expect(room.doc.getNode(board.id)?.name).toBe('Checkout');
    await agent.close();

    // Saved, it reads back as the same document.
    const before = Y.encodeStateVector(room.doc.y);
    await h.server.storage.flushDoc(file.id);
    const saved = await h.server.storage.readDoc(file.id);
    expect(saved).not.toBeNull();
    const reread = new Y.Doc();
    Y.applyUpdate(reread, saved!);
    expect(reread.getMap('nodes').size).toBe(layers);
    expect(Buffer.from(Y.encodeStateVector(reread))).toEqual(Buffer.from(before));
    const bytes = saved!.length;

    // A save that died after writing its temp file and before the rename: the saved version stays whole, and the
    // next server opens it with every layer, the agent's rename included.
    const dir = dirname(h.server.storage.docPath(file.id));
    writeFileSync(`${h.server.storage.docPath(file.id)}.deadbeef0000.tmp`, Buffer.from(saved!.subarray(0, Math.floor(bytes / 3))));
    const home = h.home;
    await h.server.close();
    const again = await startServer({ thumbnails: false }, home);
    h = again;
    // Listing files must not load a 10,000-layer document.
    const list = await (await fetch(`${again.base}/api/files`)).json() as { id: string }[];
    expect(list.some((f) => f.id === file.id)).toBe(true);
    expect(again.server.rooms.peek(file.id)).toBeUndefined();
    const reopened = await again.server.rooms.get(file.id);
    expect(reopened.doc.nodes.size).toBe(layers);
    expect(reopened.doc.getNode(board.id)?.name).toBe('Checkout');
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(true); // left for inspection, never read as the file

    // For the record in the test output: what this size costs here.
    process.stdout.write(`large file: ${layers} layers, ${(bytes / 1048576).toFixed(1)} MB saved, built in ${buildMs} ms\n`);
  }, 120_000);
});
