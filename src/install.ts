/** Install orchestration: run the command, then attempt a restart-free hot
 * mount; shape the result for the browser. */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runPlugin, progress, cancelActive, inDesktop } from './cli.ts'
import { readInstalledBundles, readInstalledVersion } from './profile.ts'
import { parseSimplePatch, hotMount, hotUnmount, listHotMounts, cleanHotDir } from './hot.ts'
import { readMountRows, stripPluginRows } from './mounts.ts'
import { invalidateUpdates } from './updates.ts'
import type { InstallerHost } from './types.ts'

/** Outcome of one install/uninstall, serialized to the browser. */
export interface InstallOutcome {
  ok: boolean
  hot: boolean
  cancelled?: boolean
  exitCode: number | null
  timedOut: boolean
  error?: string
  /** True when the failure still smells like the post-publish propagation
   * race even after the automatic retry — the UI adds a targeted hint. */
  staleRegistry?: boolean
  /** Version actually present after the add; only set when the target
   * package name was known (the update path). Null = no package dir. */
  resolvedVersion?: string | null
  /** Registry version the add was expected to land on (update path); the UI
   * warns when it differs from resolvedVersion instead of trusting ok. */
  expectedVersion?: string
  stdout: string
  stderr: string
  installed: string[]
  live: string[]
}

/**
 * Update clicked seconds after `npm publish` resolves against registry
 * metadata that has not propagated yet and dies with ERR_PNPM_NO_VERSIONS —
 * observable only in that window, and a delayed retry heals it.
 */
function smellsLikeStaleRegistry(stderr: string): boolean {
  return stderr.includes('ERR_PNPM_NO_VERSIONS')
}

const retryDelayMs = (): number => Number(process.env.DSH_INSTALL_RETRY_MS) || 20_000

const delay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * pnpm ≥10.16 gates freshly published versions behind the minimumReleaseAge
 * cooldown (on by default in pnpm 11), and it enforces the policy against the
 * WHOLE lockfile on EVERY profile operation: a lockfile holding in-window
 * entries — e.g. the transitive dependencies of an explicitly pinned install,
 * which pnpm only excludes by the pinned name — fails add AND remove alike
 * with ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION, while a bare name or `@latest`
 * resolves SILENTLY to the newest version outside the window. The Install tab
 * acts on explicit user decisions for named packages, so both verbs disable
 * the cooldown per command. pnpm builds without the setting reject the flag
 * outright — that failure is detected and the command re-run plain.
 */
const NO_COOLDOWN = '--config.minimum-release-age=0'

function rejectsCooldownFlag(stderr: string): boolean {
  return /unknown option/i.test(stderr) && /minimum-release-age/i.test(stderr)
}

/** Run one profile operation with the cooldown bypass (falling back to a
 * plain invocation on pnpm builds that reject the flag). Returns the bypass
 * state so any retry repeats the command shape that this pnpm accepts. */
async function runOpWithBypass(profile: string, args: string[]) {
  const flagged = [...args.slice(0, -1), NO_COOLDOWN, args[args.length - 1]]
  let result = await runPlugin(profile, flagged)
  let bypass = true
  if (rejectsCooldownFlag(result.stderr)) {
    bypass = false
    result = await runPlugin(profile, args)
  }
  return { result, bypass }
}

/** Run one add, retrying once after a pause when the failure is the
 * post-publish propagation race. The retry is invisible except through the
 * live progress line. */
async function runAddWithRetry(profile: string, spec: string) {
  const { result: first, bypass } = await runOpWithBypass(profile, ['add', spec])
  let result = first
  const failed = result.exitCode !== 0 && !result.timedOut && !result.cancelled
  if (failed && smellsLikeStaleRegistry(result.stderr)) {
    progress.lastLine = 'registry metadata not propagated yet — retrying once…'
    await delay(retryDelayMs())
    result = await runPlugin(profile, bypass ? ['add', NO_COOLDOWN, spec] : ['add', spec])
  }
  return result
}

/**
 * The forwarder's trailing "dsh: pnpm failed…" summary is the one line its
 * stderr may hold while pnpm itself prints the real diagnostics to STDOUT
 * (the release-policy violation does exactly that) — prefer stderr minus the
 * summary, fall back to stdout's tail so the banner names the actual error.
 */
function commandErrorText(result: { stderr: string; stdout: string }): string | undefined {
  const meaningful = result.stderr
    .split('\n')
    .filter(line => line.trim() !== '' && !/^dsh: /.test(line))
    .join('\n')
  const text = meaningful !== '' ? meaningful : result.stdout.trim()
  return text.slice(-800) || undefined
}

/**
 * After a successful add, try to hot-mount the freshly installed plugin(s)
 * so the user doesn't need to restart. Any failure degrades to "restart
 * needed" — the UI shows the difference.
 */
async function tryHotMount(host: InstallerHost, profileDirPath: string, before: Set<string>): Promise<boolean> {
  const after = readInstalledBundles(profileDirPath)
  const added = after.filter(name => !before.has(name))
  if (added.length === 0) return false
  let allMounted = true
  for (const name of added) {
    const packageDir = join(profileDirPath, 'node_modules', name)
    if (!existsSync(join(packageDir, 'package.json'))) { allMounted = false; continue }
    let patchText: string
    try {
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: string } } }
      const patchPath = manifest.dsh?.bundle?.patch
      patchText = patchPath !== undefined && existsSync(join(packageDir, patchPath))
        ? readFileSync(join(packageDir, patchPath), 'utf8')
        : '[]'
    } catch {
      allMounted = false
      continue
    }
    const rows = parseSimplePatch(patchText)
    if (rows === null) { allMounted = false; continue }
    const mounted = await hotMount(host, profileDirPath, name, rows)
    if (!mounted) allMounted = false
  }
  return allMounted && added.length > 0
}

/** Update-path context: the package being updated and the registry version
 * the add should land on, so a silently stale resolution (mirror lag, a
 * cooldown) surfaces in the outcome instead of reporting a phantom success. */
export interface InstallTarget {
  name: string
  expectedVersion?: string
}

/** Install an arbitrary spec into the active profile. */
export async function installPlugin(
  host: InstallerHost,
  profile: string,
  profileDirPath: string,
  spec: string,
  target?: InstallTarget,
): Promise<InstallOutcome> {
  cleanHotDir(profileDirPath)
  const before = new Set(readInstalledBundles(profileDirPath))
  const result = await runAddWithRetry(profile, spec)
  const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled
  if (ok) invalidateUpdates()
  let hot = false
  if (ok) hot = await tryHotMount(host, profileDirPath, before)
  return {
    ok,
    hot,
    cancelled: result.cancelled || undefined,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    error: commandErrorText(result),
    staleRegistry: (!ok && smellsLikeStaleRegistry(result.stderr)) || undefined,
    resolvedVersion: target === undefined ? undefined : readInstalledVersion(profileDirPath, target.name),
    expectedVersion: target?.expectedVersion,
    stdout: result.stdout.slice(-2000),
    stderr: result.stderr.slice(-2000),
    installed: readInstalledBundles(profileDirPath),
    live: listHotMounts(),
  }
}

/** Remove an installed plugin by name. */
export async function uninstallPlugin(
  profile: string,
  profileDirPath: string,
  name: string,
): Promise<InstallOutcome> {
  // The patch file disappears with the package, so read the rows before the
  // remove; leftover disable rows would ambush a future reinstall of the name.
  const mountRows = readMountRows(profileDirPath, name)
  // Same cooldown bypass as adds: pnpm 11 policy-checks the whole lockfile
  // on removes too, so an in-window entry anywhere blocks the uninstall.
  const { result } = await runOpWithBypass(profile, ['remove', name])
  const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled
  if (ok) {
    invalidateUpdates()
    stripPluginRows(profileDirPath, mountRows)
  }
  let unmounted = false
  if (ok) unmounted = await hotUnmount(name)
  return {
    ok,
    hot: unmounted,
    cancelled: result.cancelled || undefined,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    error: commandErrorText(result),
    stdout: result.stdout.slice(-2000),
    stderr: result.stderr.slice(-2000),
    installed: readInstalledBundles(profileDirPath),
    live: listHotMounts(),
  }
}

export { progress, cancelActive, inDesktop }
export type { InstallerHost } from './types.ts'