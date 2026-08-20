/** dsh-plugin-install host entry: mount installer HTTP routes once the
 * profile composes the webServer service, and keep the update cache warm on
 * a schedule so the badge and /status can answer without a registry hit. */

import type { Context } from '@deepseek-ai/cordis'
import { mountInstallerRoutes } from './routes.ts'
import { argvProfile, profileDir } from './profile.ts'
import { checkUpdates } from './updates.ts'
import type { InstallerHost } from './types.ts'
import type { WebServerService } from './types.ts'

export const name = 'dsh-plugin-install'

/** Optional cordis.yml configuration; profile defaults to the booted one. */
export interface Config {
  /** Profile installs target; defaults to `--profile` argv or `web`. */
  profile?: string
}

/** Structural host surface (the webServer service + dynamic plugin mounting). */
function asInstallerHost(ctx: Context & { webServer: WebServerService }): InstallerHost {
  return ctx as unknown as InstallerHost
}

/** Background cadence; the default matches the updates TTL so each tick re-checks. */
const AUTOCHECK_MS = Number(process.env.DSH_INSTALL_AUTOCHECK_MS) || 30 * 60 * 1000

/**
 * Scheduled update checks: one shortly after boot, then on the cadence. The
 * check itself is TTL-cached, so ticks between expirations are free; a
 * failure just leaves the previous answer standing.
 */
function scheduleUpdateChecks(profileDirPath: string): () => void {
  const run = (): void => { void checkUpdates(profileDirPath).catch(() => undefined) }
  const first = setTimeout(run, 5_000)
  const every = setInterval(run, AUTOCHECK_MS)
  first.unref()
  every.unref()
  return () => { clearTimeout(first); clearInterval(every) }
}

export function apply(ctx: Context, config?: Config): void {
  const profile = config?.profile ?? argvProfile() ?? 'web'
  const dirPath = profileDir(profile)
  ctx.inject(['webServer'], (hostCtx: Context) => {
    const host = asInstallerHost(hostCtx as Context & { webServer: WebServerService })
    ctx.effect(() => mountInstallerRoutes(host, { profile, profileDirPath: dirPath }), 'dsh-plugin-install: http routes')
    ctx.effect(() => scheduleUpdateChecks(dirPath), 'dsh-plugin-install: scheduled update checks')
  })
}
