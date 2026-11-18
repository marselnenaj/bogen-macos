import { describe, expect, it } from 'vitest';
import { bundleOf, installAdvice, installPlace } from '../src/main/install-location.ts';

const home = '/Users/ada';
const facts = (bundle: string, over: Partial<{ bundleFolderWritable: boolean; applicationsWritable: boolean }> = {}) => ({ bundle, home, bundleFolderWritable: true, applicationsWritable: true, ...over });

describe('where Bogen runs from, on first launch', () => {
  it('finds the bundle of the running executable, also with spaces and non-ASCII in the path', () => {
    expect(bundleOf('/Volumes/Bogen 0.1.0/Bogen.app/Contents/MacOS/Bogen')).toBe('/Volumes/Bogen 0.1.0/Bogen.app');
    expect(bundleOf('/Users/ada/Ablage – Ü/Bogen.app/Contents/MacOS/Bogen')).toBe('/Users/ada/Ablage – Ü/Bogen.app');
    expect(bundleOf('/home/ada/bogen/node_modules/electron/dist/electron')).toBeNull();
  });

  it('tells a disk image, a translocated copy, Applications and the home Applications apart', () => {
    expect(installPlace(facts('/Volumes/Bogen 0.1.0/Bogen.app', { bundleFolderWritable: false }))).toBe('disk-image');
    // A writable external drive is a place the person chose, not the disk image.
    expect(installPlace(facts('/Volumes/Work/Bogen.app'))).toBe('elsewhere');
    expect(installPlace(facts('/private/var/folders/x/T/AppTranslocation/1A2B/d/Bogen.app', { bundleFolderWritable: false }))).toBe('translocated');
    expect(installPlace(facts('/Applications/Bogen.app'))).toBe('applications');
    expect(installPlace(facts('/Users/ada/Applications/Bogen.app'))).toBe('user-applications');
    expect(installPlace(facts('/Users/ada/Downloads/Bogen.app'))).toBe('elsewhere');
  });

  it('prompts only from the disk image or a translocated copy', () => {
    for (const b of ['/Applications/Bogen.app', '/Users/ada/Applications/Bogen.app', '/Users/ada/Downloads/Bogen.app']) {
      expect(installAdvice(facts(b))).toMatchObject({ prompt: false, canMove: false });
    }
    expect(installAdvice(facts('/Volumes/Bogen 0.1.0/Bogen.app', { bundleFolderWritable: false }))).toMatchObject({ place: 'disk-image', prompt: true, canMove: true, title: 'Move Bogen to Applications?' });
  });

  it('never needs an administrator: without write access to /Applications it explains the home Applications folder', () => {
    const a = installAdvice(facts('/Volumes/Bogen 0.1.0/Bogen.app', { bundleFolderWritable: false, applicationsWritable: false }));
    expect(a).toMatchObject({ prompt: true, canMove: false });
    expect(a.detail).toContain('Applications folder in your home folder');
    expect(a.detail).toContain('No administrator password');
    expect(installAdvice(facts('/Volumes/Bogen 0.1.0/Bogen.app', { bundleFolderWritable: false })).detail).toContain('designs and settings are kept');
  });
});
