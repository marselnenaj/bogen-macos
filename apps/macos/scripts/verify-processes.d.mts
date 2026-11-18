// Types for verify-processes.mjs, for the tests in apps/macos/test.
export interface PsRow { pid: number; ppid: number; command: string }
export interface ProcessDeps { ps(): string; kill(pid: number, signal: string): void; sleep(ms: number): Promise<void>; now(): number }
export function parsePs(text: string): PsRow[];
export function ownTree(rows: PsRow[], roots: number[], bundle: string): number[];
export function stopOwn(roots: number[], bundle: string, deps: ProcessDeps, deadlines?: { graceMs?: number; termMs?: number; killMs?: number }): Promise<number[]>;
export function waitForFile(read: () => string, accept: (text: string) => boolean, what: string, deps: Pick<ProcessDeps, 'sleep' | 'now'>, ms: number): Promise<string>;
