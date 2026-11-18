import { kindHost, kindPlatform, type KindHost, type KindPlatform } from '@bogen/core';
import type { BogenServer } from './http/server.ts';
import { onOmarchy, themeEnv } from './omarchy-themes.ts';

const hosts = new WeakMap<BogenServer, KindHost>();

/** Tests only: what the server takes itself for. Not reachable over HTTP. */
export function setKindHostForTests(app: BogenServer, host: KindHost): void {
  hosts.set(app, host);
}

/** The computer this server runs on, for the kinds of project it makes: a Mac, Omarchy, or anything else. */
export function serverKindHost(app: BogenServer, platform: NodeJS.Platform = process.platform): KindHost {
  return hosts.get(app) ?? kindHost(platform, onOmarchy({ ...themeEnv(app), platform }));
}

/** `GET /api/platform`: the editor's one answer for which kinds and theme sections belong to this computer. */
export function platformInfo(app: BogenServer): KindPlatform {
  return kindPlatform(serverKindHost(app));
}
