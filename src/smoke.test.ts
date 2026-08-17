/**
 * dsh-plugin-install end-to-end smoke: real source dsh, temp DSH_HOME,
 * install this package into a profile, boot `dsh web`, then probe the
 * installer routes.
 *
 * Gate: DSH_DESKTOP_PLUGIN_SMOKE=1 (mirrors desktop's market.smoke.test.ts).
 * Requires: deepseek-harness checked out beside this repo, `pnpm install`
 * already run there, and a host that permits capturing child-process output
 * (the DSH sandbox denies spawned-pipe capture with EPERM).
 */

import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const srcDir = fileURLToPath(new URL('.', import.meta.url))
const pluginDir = join(srcDir, '..')
// Layout convention: this repo and deepseek-harness/ sit side by side under
// the same parent directory (src → repo → parent).
const repoRoot = join(srcDir, '..', '..', 'deepseek-harness')
const guard = existsSync(join(repoRoot, 'apps', 'cli', 'src', 'bin.ts'))
const [nodeMajor, nodeMinor] = process.version.slice(1).split('.').map(Number)
const nodeOk = (nodeMajor === 22 && nodeMinor >= 19) || nodeMajor >= 24

const smokeRoot = mkdtempSync(join(tmpdir(), 'dsh-plugin-install-smoke-'))
const dshBin = join(repoRoot, 'apps', 'cli', 'src', 'bin.ts')

/**
 * Test env with a CLEAN PATH: vitest prepends every ancestor
 * node_modules/.bin, which on this machine drags in a stray pnpm 11.7.0
 * from desktop/ (a build-toolchain dependency). dsh's plugin forwarder runs
 * `pnpm` via PATH, so that stray shadows the system pnpm and breaks
 * installs. Rebuild PATH from the system roots only.
 */
function smokeEnv(dshHome: string): NodeJS.ProcessEnv {
  const systemBins = [
    process.env.npm_config_prefix,
    join(homedir(), 'AppData', 'Roaming', 'npm'),
    // The pnpm .cmd shim invokes `node`; its runtime dir must be on PATH.
    dirname(process.execPath),
  ].filter((value): value is string => typeof value === 'string' && value !== '')
  const pathValue = [...systemBins, 'C:\\Windows\\system32', 'C:\\Windows'].join(';')
  return { ...process.env, DSH_HOME: dshHome, PATH: pathValue }
}

/** Run the source-mode dsh CLI, capturing output (test env only). */
function dsh(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx/esm', dshBin, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
    }, (error, stdout, stderr) => {
      // execFile: a non-zero exit surfaces as an error whose `code` is the
      // numeric exit code; ENOENT and friends carry a string code.
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({ code, out: `${stdout}\n${stderr}` })
    })
  })
}

/** Boot `dsh web` on a random port; resolve once the URL line appears. */
function bootWeb(dshHome: string): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    // `dsh web` is a hardcoded alias for `--profile web` and rejects any
    // parent --profile (deepseek-harness apps/cli/src/args.ts), so the
    // profile under test is named "web" and the flag must not appear here.
    const child = spawn(process.execPath, ['--import', 'tsx/esm', dshBin, 'web', '--port', '0', '--host', '127.0.0.1'], {
      cwd: repoRoot,
      env: { ...smokeEnv(dshHome), DSH_DESKTOP: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffer = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`timed out waiting for dsh web URL line; output:\n${buffer.slice(-4000)}`))
    }, 120_000)
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString()
      const match = /dsh web: http:\/\/127\.0\.0\.1:(\d+)/.exec(buffer)
      if (match !== null) {
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        child.stderr?.off('data', onData)
        resolve({ port: Number(match[1]) })
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    afterAll(() => { try { child.kill() } catch { /* already gone */ } })
  })
}

describe.skipIf(process.env.DSH_DESKTOP_PLUGIN_SMOKE !== '1' || !guard || !nodeOk)('dsh-plugin-install smoke', () => {
  afterAll(() => {
    // Only ever remove the exact temp dir this test created.
    if (smokeRoot.startsWith(tmpdir()) && smokeRoot.includes('dsh-plugin-install-smoke-')) {
      rmSync(smokeRoot, { recursive: true, force: true })
    }
  })

  it('installs the package into a temp profile, boots web, and serves the installer routes', { timeout: 240_000 }, async () => {
    const env = smokeEnv(smokeRoot)

    // 1. `dsh plugin --profile web add file:<this package>` — the profile
    // must be named "web": `dsh web` boots exactly that profile and no other.
    const install = await dsh(['plugin', '--profile', 'web', 'add', `file:${pluginDir}`], env)
    if (install.code !== 0) console.log('[smoke] FULL dsh output:\n' + install.out)
    expect(install.code, install.out).toBe(0)

    // 2. The reconcile wrote dsh.profile.bundles with our package.
    const manifest = JSON.parse(readFileSync(join(smokeRoot, 'profiles', 'web', 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: string[] } }
    }
    expect(manifest.dsh?.profile?.bundles).toContain('dsh-plugin-install')

    // 3. Boot `dsh web --port 0` and wait for the URL line.
    const { port } = await bootWeb(smokeRoot)

    // 4. Probe the installer routes.
    const status = await fetch(`http://127.0.0.1:${port}/dsh-plugin-install/status`)
    expect(status.status).toBe(200)
    const body = await status.json() as { installed?: string[]; desktop?: boolean }
    expect(body.installed).toContain('dsh-plugin-install')
    expect(body.desktop).toBe(false)

    // 5. Update checks: this package is installed via file: → linked, no
    // network check, version read from node_modules.
    const updates = await fetch(`http://127.0.0.1:${port}/dsh-plugin-install/updates?force=1`)
    expect(updates.status).toBe(200)
    const updatesBody = await updates.json() as { updates?: Record<string, { kind?: string; updateAvailable?: boolean; version?: string }> }
    expect(updatesBody.updates?.['dsh-plugin-install']).toMatchObject({ kind: 'linked', updateAvailable: false })

    // 6. Updating a linked plugin is refused with an actionable error.
    const origin = `http://127.0.0.1:${port}`
    const update = await fetch(`${origin}/dsh-plugin-install/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: origin, host: `127.0.0.1:${port}` },
      body: JSON.stringify({ name: 'dsh-plugin-install' }),
    })
    expect(update.status).toBe(400)
    expect(await update.json()).toMatchObject({ error: expect.stringContaining('checkout') as unknown })
  })
})