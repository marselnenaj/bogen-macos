// Types for dmg-layout.mjs, for the tests in apps/macos/test.
export interface DmgItem { name: string; x: number; y: number }
export interface DmgPlan {
  productName: string; app: string; volumeName: string; fileName: string; release: boolean;
  window: { x: number; y: number; width: number; height: number }; iconSize: number; textSize: number;
  items: DmgItem[]; background: string; volumeIcon: string; entries: string[];
  words: { title: string; action: string; note: string[] };
}
export interface DsRecord { name: string; code: string; type: string; value: Buffer | number | string | boolean | bigint }
export interface AliasTarget { volumeName: string; volumeCreated: number; mountPoint: string; path: string; cnid: number; parentCnid: number; created: number }
export const BACKGROUND_SIZE: { width: number; height: number };
export const CUSTOM_ICON_FINDER_INFO: string;
export function dmgPlan(o: { version: string; arch: string; release: boolean; productName?: string }): DmgPlan;
export function backgroundWords(release: boolean, productName?: string): DmgPlan['words'];
export function backgroundSvg(plan: DmgPlan): string;
export type PlistValue = boolean | number | string | Buffer | { real: number } | PlistValue[] | { [key: string]: PlistValue };
export function bplist(root: PlistValue): Buffer;
export function aliasRecord(target: AliasTarget): Buffer;
export function readAlias(b: Buffer): { version: number; size: number; volumeName: string; fileName: string; parentCnid: number; cnid: number; posixPath?: string; mountPoint?: string; carbonPath?: string; unicodeName?: string };
export function layoutRecords(plan: DmgPlan, alias?: Buffer): DsRecord[];
export function dsStore(records: DsRecord[]): Buffer;
export function readDsStore(file: Buffer): { records: DsRecord[]; count: number };
export function readIloc(b: Buffer): { x: number; y: number };
