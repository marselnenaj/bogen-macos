import { useSyncExternalStore } from 'react';
import { PENDING_KIND_PLATFORM, kindPlatform, type KindHost, type KindPlatform } from '@bogen/core';

/**
 * Which kinds of project and which theme section belong to the computer the server runs on, asked once per visit
 * (`GET /api/platform`). Home's kinds, the Kind menu and the theme sections all read this one answer; none of them
 * guesses the platform from the browser. Until it arrives, and when it cannot be had, the state is platform-safe
 * (`PENDING_KIND_PLATFORM`): only kinds every computer has, the system kinds that files already have, and no theme
 * section, so a Mac never shows Omarchy's choices for a moment, nor Omarchy a Mac's.
 */

let current: KindPlatform = PENDING_KIND_PLATFORM;
let known = false;
let asked: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: KindPlatform): void {
  current = next;
  known = true;
  for (const l of listeners) l();
}

const HOSTS: readonly KindHost[] = ['macos', 'omarchy', 'other'];

/**
 * The server's answer, checked: the lists are rebuilt here from the host, never trusted. An answer without a host this
 * editor knows is no answer: it stays platform-safe (pending), never "every kind".
 */
export function fromAnswer(raw: unknown): KindPlatform | null {
  const host = (raw as { host?: unknown } | null)?.host;
  return HOSTS.includes(host as KindHost) ? kindPlatform(host as KindHost) : null;
}

/** How long one ask may take before it counts as failed (and is asked again on the next visit to Home). */
const ASK_TIMEOUT_MS = 10_000;
const RETRY_MS = 5_000;

function ask(): void {
  asked ??= (async () => {
    const res = await fetch('/api/platform', { signal: AbortSignal.timeout(ASK_TIMEOUT_MS) });
    const answer = res.ok ? fromAnswer(await res.json()) : null;
    if (!answer) throw new Error(`no platform answer (${res.status})`);
    set(answer);
  })().catch(() => {
    // Slow, offline, or a server without the answer: stay platform-safe, and ask again while Home is still open.
    asked = null;
    if (listeners.size) setTimeout(() => { if (listeners.size && !known) ask(); }, RETRY_MS);
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ask();
  return () => listeners.delete(listener);
}

/** This computer's kinds. `known` is false until the server answered. */
export function useKindPlatform(): KindPlatform & { known: boolean } {
  const p = useSyncExternalStore(subscribe, () => current, () => PENDING_KIND_PLATFORM);
  return { ...p, known };
}

/** The current answer outside React. */
export function kindPlatformNow(): KindPlatform & { known: boolean } {
  return { ...current, known };
}

/** Tests only: forget the answer, so the next subscribe asks again. */
export function resetKindPlatformForTests(): void {
  asked = null;
  current = PENDING_KIND_PLATFORM;
  known = false;
}

/** Tests only: ask now (what a subscribe does) and wait for the outcome. */
export async function askKindPlatformForTests(): Promise<void> {
  ask();
  await asked;
}
