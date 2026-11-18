// Types for verify-engine.mjs, for the tests in apps/macos/test.
export function expectedIconSets(repoRoot: string): string[];
export function staticEngineProblems(dist: string, iconSets: string[]): string[];
export interface McpStdio {
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
  pid: number | undefined;
}
export function mcpStdio(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): McpStdio;
export function engineChecks(call: (name: string, args: Record<string, unknown>) => Promise<any>, must: (cond: boolean, what: string) => void): Promise<string>;
