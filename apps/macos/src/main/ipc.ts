// The only messages app-owned pages may send to the main process. Each channel has an exact payload shape; anything
// else is refused before a handler runs. There is no channel that takes a path, a URL or a command line.

import { isShellUrl } from './policy.ts';
import { validPort } from './settings.ts';

export const AGENT_CLIENTS = ['claude-code', 'codex', 'opencode'] as const;
export type AgentClient = typeof AGENT_CLIENTS[number];

export type IpcRequest =
  | { channel: 'shell:state' }
  | { channel: 'shell:retry' }
  | { channel: 'shell:use-port'; port: number }
  | { channel: 'shell:open-editor' }
  | { channel: 'shell:show-logs' }
  | { channel: 'shell:quit' }
  | { channel: 'settings:get' }
  | { channel: 'settings:set'; updateChecks?: boolean; port?: number; menuBarIcon?: boolean }
  | { channel: 'settings:connect-agent'; client: AgentClient }
  | { channel: 'settings:install-cli' }
  | { channel: 'settings:reveal-data' }
  | { channel: 'updates:check' }
  | { channel: 'updates:install' }
  | { channel: 'legacy:import' }
  | { channel: 'legacy:skip' }
  | { channel: 'about:info' };

export const CHANNELS = [
  'shell:state', 'shell:retry', 'shell:use-port', 'shell:open-editor', 'shell:show-logs', 'shell:quit',
  'settings:get', 'settings:set', 'settings:connect-agent', 'settings:install-cli', 'settings:reveal-data',
  'updates:check', 'updates:install', 'legacy:import', 'legacy:skip', 'about:info',
] as const satisfies readonly IpcRequest['channel'][];

export class IpcRefused extends Error {}

function plainObject(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) throw new IpcRefused('The payload is not a plain object.');
  return v as Record<string, unknown>;
}

function onlyKeys(o: Record<string, unknown>, keys: string[]): void {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) throw new IpcRefused(`Unexpected field: ${extra.join(', ')}`);
}

/** Validates one message. `senderUrl` is the sending frame's URL; `isMainFrame` whether it is the top frame. */
export function parseIpc(channel: unknown, payload: unknown, senderUrl: string, isMainFrame: boolean): IpcRequest {
  if (!isMainFrame || !isShellUrl(senderUrl)) throw new IpcRefused('Only Bogen\'s own pages may ask for this.');
  if (typeof channel !== 'string' || !(CHANNELS as readonly string[]).includes(channel)) throw new IpcRefused('Unknown channel.');
  const p = plainObject(payload);
  switch (channel) {
    case 'shell:use-port': {
      onlyKeys(p, ['port']);
      if (!validPort(p.port)) throw new IpcRefused('The port must be a whole number from 1024 to 65535.');
      return { channel, port: p.port };
    }
    case 'settings:set': {
      onlyKeys(p, ['updateChecks', 'port', 'menuBarIcon']);
      const out: IpcRequest = { channel };
      if (p.updateChecks !== undefined) {
        if (typeof p.updateChecks !== 'boolean') throw new IpcRefused('updateChecks must be true or false.');
        out.updateChecks = p.updateChecks;
      }
      if (p.menuBarIcon !== undefined) {
        if (typeof p.menuBarIcon !== 'boolean') throw new IpcRefused('menuBarIcon must be true or false.');
        out.menuBarIcon = p.menuBarIcon;
      }
      if (p.port !== undefined) {
        if (!validPort(p.port)) throw new IpcRefused('The port must be a whole number from 1024 to 65535.');
        out.port = p.port;
      }
      return out;
    }
    case 'settings:connect-agent': {
      onlyKeys(p, ['client']);
      if (!(AGENT_CLIENTS as readonly unknown[]).includes(p.client)) throw new IpcRefused('Unknown agent client.');
      return { channel, client: p.client as AgentClient };
    }
    default:
      onlyKeys(p, []);
      return { channel } as IpcRequest;
  }
}
