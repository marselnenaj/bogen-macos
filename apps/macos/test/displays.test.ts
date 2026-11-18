import { describe, expect, it } from 'vitest';
import { DisplayReporter, displayReport, type DisplayReport } from '../src/main/displays.ts';

const builtIn = { label: 'Built-in Retina Display', size: { width: 1512, height: 982 }, scaleFactor: 2, internal: true };
const external = { label: 'Studio Display', size: { width: 2560, height: 1440 }, scaleFactor: 2, internal: false };

describe('this Mac\'s displays for Mac theme wallpapers', () => {
  it('reports backing pixels (size × scale factor) and scale, built-in first, and leaves out fractional scales', () => {
    expect(displayReport([external, builtIn, { label: 'Odd', size: { width: 1000, height: 800 }, scaleFactor: 1.5, internal: false }])).toEqual([
      { label: 'Built-in Retina Display', width: 3024, height: 1964, scale: 2 },
      { label: 'Studio Display', width: 5120, height: 2880, scale: 2 },
    ]);
  });

  it('sends only while the server runs, one request at a time, and coalesces a burst of display events into one more', async () => {
    const sent: DisplayReport[][] = [];
    let ready = false;
    let release: () => void = () => {};
    const reporter = new DisplayReporter({
      read: () => [builtIn],
      ready: () => ready,
      send: (r) => { sent.push(r); return new Promise<void>((res) => { release = res; }); },
    });
    await reporter.report();
    expect(sent).toHaveLength(0);
    ready = true;
    const first = reporter.report();
    for (let i = 0; i < 10; i++) void reporter.report();
    expect(sent).toHaveLength(1);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(2);
    release();
    await first;
    expect(reporter.sent).toBe(2);
  });

  it('drops a failed send without retrying', async () => {
    let calls = 0;
    const reporter = new DisplayReporter({ read: () => [builtIn], ready: () => true, send: async () => { calls++; throw new Error('offline'); } });
    await reporter.report();
    expect(calls).toBe(1);
  });
});
