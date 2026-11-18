// Types for plist-policy.mjs, for the tests in apps/macos/test.
export const ATS_KEY: 'NSAppTransportSecurity';
export interface PlistTool { has(plistPath: string, key: string): boolean; remove(plistPath: string, key: string): void }
export const plutil: PlistTool;
export function appInfoPlists(app: string): string[];
export function stripTransportSecurity(app: string, tool?: PlistTool): string[];
export function transportSecurityLeft(app: string, tool?: PlistTool): string[];
