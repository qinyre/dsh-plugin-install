/** dsh-plugin-install host entry: mount installer HTTP routes once the
 * profile composes the webServer service, and keep the update cache warm on
 * a schedule so the badge and /status can answer without a registry hit. */

import type { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { mountInstallerRoutes } from './routes.ts'
import { activeProfileContext, argvProfile, profileDir } from './profile.ts'
import { checkUpdates } from './updates.ts'
import type { InstallerHost, LoaderEntryView } from './types.ts'
import type { WebServerService } from './types.ts'

export const name = 'dsh-plugin-install'

/** Optional cordis.yml configuration; profile defaults to the booted one. */
export interface Config {
  /** Profile installs target; defaults to `--profile` argv or `web`. */
  profile?: string
}

/** Structural host surface: the webServer service, dynamic plugin mounting,
 * and the loader entries hot-reload polling watches. */
function asInstallerHost(ctx: Context & { webServer: WebServerService }): InstallerHost {
  const shaped = ctx as unknown as InstallerHost & { loader?: { entries?: () => unknown[] } }
  return {
    webServer: shaped.webServer,
    plugin: (plugin, config) => shaped.plugin(plugin, config),
    loaderEntries: () => (shaped.loader?.entries?.() ?? []) as readonly LoaderEntryView[],
  }
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
  // Where does the installer address installs, updates, and mount rows? An
  // explicit cordis config wins. Otherwise the module's own location names
  // the active profile — the desktop host never puts `--profile` on argv, so
  // the argv fallback would silently pick `web` there and read the wrong
  // profile's packages (the missing desktop update dots). The argv fallback
  // remains for development layouts a `file:` install places outside any
  // profile.
  const active = activeProfileContext(fileURLToPath(import.meta.url))
  const profile = config?.profile ?? active?.profile ?? argvProfile() ?? 'web'
  const dirPath = config?.profile !== undefined || active === undefined
    ? profileDir(profile)
    : active.profileDirPath
  ctx.inject(['webServer'], (hostCtx: Context) => {
    const host = asInstallerHost(hostCtx as Context & { webServer: WebServerService })
    // dsh 0.1.2+ gives every boot a fresh launch token; the restart handoff
    // route needs this process's tokened URL. The connection service carries
    // that token and may mount after webServer, so resolve both lazily per
    // request (ctx.get answers undefined for a not-yet-active service).
    const tokenedUrl = (): string | undefined => {
      const port = host.webServer.port
      if (port === undefined) return undefined
      const connection = hostCtx.get('connection') as { authenticatedUrl?(baseUrl: string): string } | undefined
      return connection?.authenticatedUrl?.(`http://127.0.0.1:${port}`)
    }
    ctx.effect(() => mountInstallerRoutes(host, { profile, profileDirPath: dirPath, tokenedUrl }), 'dsh-plugin-install: http routes')
    ctx.effect(() => scheduleUpdateChecks(dirPath), 'dsh-plugin-install: scheduled update checks')
  })
}
