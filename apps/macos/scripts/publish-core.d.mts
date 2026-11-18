import type { AppManifest } from '../src/main/update-core.ts';
export function verifyUpdateFiles(directory: string, publicKeys?: readonly string[]): Promise<{ manifest: AppManifest; files: string[] }>;
