// Types for sign-plan.mjs, for the tests in apps/macos/test.
export type MachOKind = 'executable' | 'library';
export interface PlanItem { file: string; kind: MachOKind; entitlements: boolean }
export function machOKind(path: string): MachOKind | null;
export function shallowBundleTraps(root: string): string[];
export function payloadPlan(app: string): PlanItem[];
export function codesignArgs(item: PlanItem, options: { identity?: string; entitlements: string }): string[];
export function electronEntitlements(file: string, files: { payload: string; shell: string }): string;
