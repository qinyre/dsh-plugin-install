/**
 * Route-contract tests: the Install tab renders whatever body arrives, so a
 * failed command must travel as a 200 outcome (ok:false), never as an HTTP
 * error status. Regression: garbage specs used to answer 502, the client's
 * fetch helper threw the body away, and the tab showed nothing at all.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('./install.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./install.ts')>()
  return { ...actual, installPlugin: vi.fn(), uninstallPlugin: vi.fn() }
})

vi.mock('./restart.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./restart.ts')>()
  return { ...actual, scheduleSelfRestart: vi.fn(), canSelfRestart: () => true }
})

import { mountInstallerRoutes } from './routes.ts'
import { installPlugin, uninstallPlugin } from './install.ts'
import { scheduleSelfRestart } from './restart.ts'
import { progress } from './cli.ts'
import type { InstallOutcome } from './install.ts'
import type { InstallerHost, WebServerService } from './types.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-install-routes-'))
afterAll(() => {
  if (root.startsWith(tmpdir()) && root.includes('dsh-plugin-install-routes-')) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** Mount the routes over a capturing webServer stub; profile lives in `root`. */
function mountRoutes(): Map<string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>> {
  const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>()
  const webServer: WebServerService = {
    register: (route) => {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }
  const host: InstallerHost = {
    webServer,
    plugin: () => ({ await: () => Promise.resolve(undefined), dispose: () => undefined }),
  }
  mountInstallerRoutes(host, { profile: 'web', profileDirPath: root })
  return routes
}

/** POST with a JSON body and matching origin/host (passes the CSRF fence). */
async function post(path: string, body: unknown, routes: Map<string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>): Promise<{ status: number; body: any }> {
  const payload = Buffer.from(JSON.stringify(body))
  const request = {
    method: 'POST',
    url: path,
    headers: { origin: 'http://127.0.0.1:1', host: '127.0.0.1:1' },
    async *[Symbol.asyncIterator]() { if (payload.length > 0) yield payload },
  } as unknown as IncomingMessage
  let status = 0
  let text = ''
  const response = {
    writeHead(code: number) { status = code },
    end(chunk?: unknown) { text = typeof chunk === 'string' ? chunk : '' },
  } as unknown as ServerResponse
  await routes.get(path)?.(request, response)
  return { status, body: text === '' ? undefined : JSON.parse(text) }
}

const failedOutcome: InstallOutcome = {
  ok: false,
  hot: false,
  exitCode: 1,
  timedOut: false,
  error: 'ERR_PNPM_NO_MATCHING_VERSION',
  stdout: '',
  stderr: '404 Not Found - GET https://registry.npmjs.org/qqqzzz',
  installed: [],
  live: [],
}

describe('installer route contract', () => {
  it('answers a failed install with 200 and the outcome body', async () => {
    vi.mocked(installPlugin).mockResolvedValue(failedOutcome)
    const { status, body } = await post('/dsh-plugin-install/install', { spec: 'qqqzzz' }, mountRoutes())
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.error).toContain('ERR_PNPM_NO_MATCHING_VERSION')
  })

  it('passes a successful install through unchanged', async () => {
    vi.mocked(installPlugin).mockResolvedValue({ ...failedOutcome, ok: true, hot: true, error: undefined, installed: ['demo-plugin'] })
    const { status, body } = await post('/dsh-plugin-install/install', { spec: 'demo-plugin' }, mountRoutes())
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, hot: true, installed: ['demo-plugin'] })
  })

  it('still reports request-level problems as HTTP errors', async () => {
    const { status, body } = await post('/dsh-plugin-install/install', { spec: 'a b c' }, mountRoutes())
    expect(status).toBe(400)
    expect(body.error).toContain('unsafe characters')
  })

  it('answers a failed uninstall with 200 and the outcome body', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['demo-plugin'] } } }))
    vi.mocked(uninstallPlugin).mockResolvedValue({ ...failedOutcome, exitCode: 1 })
    const { status, body } = await post('/dsh-plugin-install/uninstall', { name: 'demo-plugin' }, mountRoutes())
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.error).toContain('ERR_PNPM_NO_MATCHING_VERSION')
  })
})

describe('mount route（挂载/停用）', () => {
  function seedBundle(name: string, patch: string): void {
    const dir = join(root, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name,
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }), 'utf8')
    writeFileSync(join(dir, 'cordis.patch.yml'), patch, 'utf8')
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      dependencies: { [name]: '^1.0.0' },
      dsh: { profile: { bundles: [name, 'dsh-plugin-install'] } },
    }))
  }

  it('pauses a toggleable plugin by writing the profile patch layer', async () => {
    seedBundle('demo-plugin', '- insert:\n    - id: demo-plugin\n      name: demo-plugin\n')
    const { status, body } = await post('/dsh-plugin-install/mount', { name: 'demo-plugin', enabled: false }, mountRoutes())
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, name: 'demo-plugin', mounted: false })
    const row = body.plugins.find((row: { name: string }) => row.name === 'demo-plugin')
    expect(row).toMatchObject({ mounted: false, toggleable: true, repository: null })
    expect(readFileSync(join(root, 'cordis.patch.yml'), 'utf8')).toContain('- id: demo-plugin')
  })

  it('refuses to pause the installer itself', async () => {
    const { status, body } = await post('/dsh-plugin-install/mount', { name: 'dsh-plugin-install', enabled: false }, mountRoutes())
    expect(status).toBe(400)
    expect(body.error).toContain('installer itself')
  })

  it('refuses unknown plugins and non-toggleable patches', async () => {
    const unknown = await post('/dsh-plugin-install/mount', { name: 'ghost', enabled: false }, mountRoutes())
    expect(unknown.status).toBe(400)
    seedBundle('grouped-plugin', '- insert:\n  - id: g\n    group: true\n')
    const grouped = await post('/dsh-plugin-install/mount', { name: 'grouped-plugin', enabled: false }, mountRoutes())
    expect(grouped.status).toBe(400)
    expect(grouped.body.error).toContain('row-wise')
  })
})

describe('restart route（独立环境自重启）', () => {
  it('answers ok standalone and hands off after the response', async () => {
    delete process.env.DSH_DESKTOP
    progress.active = false
    const { status, body } = await post('/dsh-plugin-install/restart', {}, mountRoutes())
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, restarting: true })
    expect(scheduleSelfRestart).toHaveBeenCalledTimes(1)
  })

  it('still refuses while a plugin operation is running', async () => {
    delete process.env.DSH_DESKTOP
    progress.active = true
    const { status } = await post('/dsh-plugin-install/restart', {}, mountRoutes())
    expect(status).toBe(409)
    progress.active = false
  })
})
