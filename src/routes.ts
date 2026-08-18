/** HTTP routes bridging the Settings UI to the installer host. This layer
 * only parses requests, validates specs, calls the service modules, and
 * serializes responses — process spawning lives in cli.ts, orchestration in
 * install.ts. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody, sameOrigin, sendJson } from './http.ts'
import { installPlugin, uninstallPlugin, progress, cancelActive, inDesktop } from './install.ts'
import { readInstalledBundles, readInstalledSpecs, readInstalledVersion, isLocalLink } from './profile.ts'
import { checkUpdates, fetchNpmLatest, isUpgrade } from './updates.ts'
import { validateSpec } from './cli.ts'
import type { InstallerHost } from './types.ts'

/** Host-context builder for testability: real code wires host.webServer. */
export interface RouteConfig {
  profile: string
  profileDirPath: string
}

/**
 * Register the installer's HTTP routes.
 * @returns a disposer that removes every registered route.
 */
export function mountInstallerRoutes(
  host: InstallerHost,
  config: RouteConfig,
): () => void {
  let installing = false

  const disposers = [
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-plugin-install/status',
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        sendJson(response, 200, {
          desktop: inDesktop(),
          active: progress.active,
          target: progress.target,
          startedAt: progress.startedAt,
          lastLine: progress.lastLine,
          lastError: progress.lastError,
          cancelling: progress.cancelling,
          installed: readInstalledBundles(config.profileDirPath),
        })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-plugin-install/installed',
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        sendJson(response, 200, {
          profile: config.profile,
          installed: readInstalledBundles(config.profileDirPath),
          desktop: inDesktop(),
        })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-plugin-install/install',
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        if (installing) {
          sendJson(response, 409, { error: 'another install is already running' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { spec?: unknown }
          const spec = typeof body.spec === 'string' ? body.spec : ''
          const invalid = validateSpec(spec)
          if (invalid !== null) {
            sendJson(response, 400, { error: invalid })
            return
          }
          installing = true
          try {
            const outcome = await installPlugin(host, config.profile, config.profileDirPath, spec)
            // A failed command is a valid result, not an HTTP error: the tab
            // renders the ok:false banner from this body, and a non-2xx status
            // makes the client's fetch helper discard the body entirely.
            sendJson(response, 200, outcome)
          } finally {
            installing = false
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-plugin-install/uninstall',
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        if (installing) {
          sendJson(response, 409, { error: 'another install is already running' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { name?: unknown }
          const name = typeof body.name === 'string' ? body.name : ''
          if (name === '' || !readInstalledBundles(config.profileDirPath).includes(name)) {
            sendJson(response, 400, { error: 'plugin is not installed' })
            return
          }
          installing = true
          try {
            const outcome = await uninstallPlugin(config.profile, config.profileDirPath, name)
            // Outcome body, always 200 — see the install route.
            sendJson(response, 200, outcome)
          } finally {
            installing = false
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-plugin-install/updates',
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        try {
          const force = (request.url ?? '').includes('force=1')
          sendJson(response, 200, { updates: await checkUpdates(config.profileDirPath, force) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-plugin-install/update',
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        if (installing) {
          sendJson(response, 409, { error: 'another install is already running' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { name?: unknown }
          const name = typeof body.name === 'string' ? body.name : ''
          const spec = readInstalledSpecs(config.profileDirPath)[name]
          if (name === '' || spec === undefined) {
            sendJson(response, 400, { error: 'plugin is not installed' })
            return
          }
          if (isLocalLink(spec)) {
            sendJson(response, 400, { error: 'locally linked plugins update from their checkout' })
            return
          }
          // Re-running add re-resolves the source: git HEAD for github specs,
          // dist-tag latest for registry installs.
          const target = spec.startsWith('github:') ? spec.replace(/#.*$/, '') : `${name}@latest`
          // Never let `@latest` walk the profile BACKWARDS (dshmarket #64): a
          // package whose latest dist-tag was left on an older release turns
          // this update into a downgrade that also rewrites the pin. Detection
          // already hides the button; this guards the route itself. Unreadable
          // versions fall through and update as before.
          if (!spec.startsWith('github:')) {
            const installedVersion = readInstalledVersion(config.profileDirPath, name)
            const registryLatest = await fetchNpmLatest(name)
            if (installedVersion !== null && registryLatest !== null && !isUpgrade(installedVersion, registryLatest)) {
              sendJson(response, 400, {
                error: `already current: the registry's latest (${registryLatest}) is not newer than the installed ${installedVersion}, so updating would downgrade it`,
              })
              return
            }
          }
          installing = true
          try {
            const outcome = await installPlugin(host, config.profile, config.profileDirPath, target)
            // Outcome body, always 200 — see the install route.
            sendJson(response, 200, outcome)
          } finally {
            installing = false
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-plugin-install/cancel',
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        if (!cancelActive()) {
          sendJson(response, 400, { error: 'no operation is running' })
          return
        }
        sendJson(response, 200, { ok: true, cancelled: true, target: progress.target })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-plugin-install/restart',
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        // Desktop mode: the sidecar is under the app's supervision; restarts
        // go through the shell (tray / desktop IPC), never a raw re-exec.
        if (inDesktop()) {
          sendJson(response, 403, { error: 'restart is handled by the desktop shell (tray menu / app restart)' })
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        if (progress.active) {
          sendJson(response, 409, { error: 'cannot restart while a plugin operation is running' })
          return
        }
        // Ordinary DSH: this route is a no-op stub in v1 — actual self-restart
        // is owned by the host deployment. We answer 501 so clients never
        // believe a restart happened.
        logStubRestart(request)
        sendJson(response, 501, { error: 'self-restart is not implemented; restart dsh yourself' })
      },
    }),
  ]

  return () => { for (const dispose of disposers) dispose() }
}

/** Log the rejected restart attempt at INFO for debuggability. */
function logStubRestart(_request: IncomingMessage): void {
  // No logger dependency in v1; kept as a named hook so deployments can wire
  // a real one without changing the route table.
}