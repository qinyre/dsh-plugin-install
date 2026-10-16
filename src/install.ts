/** Install orchestration: run the command, then attempt a restart-free hot
 * mount; shape the result for the browser. */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runPlugin, progress, cancelActive, inDesktop } from './cli.ts'
import { readInstalledBundles, readInstalledVersion } from './profile.ts'
import { parseSimplePatch, hotMount, hotUnmount, listHotMounts, cleanHotDir, pauseForSwap, liveFibersForPackage, capturePluginInventory, reconcileRemovedPlugin, type SwapLease, type HotReloadTimeouts } from './hot.ts'
import { auditProfileTree, repairableIssues } from './integrity.ts'
import { readMountRows, stripPluginRows } from './mounts.ts'
import { appendCooldownExclusion } from './workspace.ts'
import { invalidateUpdates } from './updates.ts'
import { SELF_NAME, type InstallerHost } from './types.ts'

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
  /** Why an update could not be hot-reloaded and still wants a restart. */
  hotNote?: string
  /** Post-uninstall repair outcome: requirements re-installed after the
   * removal pruned a hoisted copy another plugin relied on, and issues that
   * remain broken (auto-repair impossible or failed). */
  integrity?: {
    repaired: string[]
    broken: Array<{ plugin: string; requirement: string }>
  }
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
 * live progress line. Returns whether pnpm accepted the cooldown bypass —
 * a bypassed add lands an in-window entry in the lockfile that every
 * cooldown-respecting tool then trips over until it ages out. */
async function runAddWithRetry(profile: string, spec: string) {
  const { result: first, bypass } = await runOpWithBypass(profile, ['add', spec])
  let result = first
  const failed = result.exitCode !== 0 && !result.timedOut && !result.cancelled
  if (failed && smellsLikeStaleRegistry(result.stderr)) {
    progress.lastLine = 'registry metadata not propagated yet — retrying once…'
    await delay(retryDelayMs())
    result = await runPlugin(profile, bypass ? ['add', NO_COOLDOWN, spec] : ['add', spec])
  }
  return { result, bypass }
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
  // An update of a running plugin swaps its package under a live instance.
  // Pause the running generation FIRST: its fs.watch handles (skill roots,
  // vendored directories) make Windows refuse the mid-swap deletion and pnpm
  // dies with the package gutted. Pausing disposes the fibers — closing the
  // watchers — before pnpm touches anything. Never for the installer itself
  // (the pause would tear down the fiber serving this very request).
  const isUpdate = target?.name !== undefined && target.name !== SELF_NAME && before.has(target.name)
  let paused: { lease?: SwapLease; blocked?: string } | null = null
  if (isUpdate) paused = await pauseForSwap(host, profileDirPath, target!.name)
  if (paused?.blocked !== undefined) {
    return {
      ok: false,
      hot: false,
      exitCode: 1,
      timedOut: false,
      error: `${paused.blocked}; restart dsh, then update again`,
      resolvedVersion: readInstalledVersion(profileDirPath, target!.name),
      expectedVersion: target?.expectedVersion,
      stdout: '',
      stderr: paused.blocked,
      installed: readInstalledBundles(profileDirPath),
      live: listHotMounts(),
    }
  }
  const { result, bypass } = await runAddWithRetry(profile, spec)
  const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled
  if (ok) invalidateUpdates()
  let hot = false
  let hotNote: string | undefined
  if (ok) hot = await tryHotMount(host, profileDirPath, before)
  // A bypassed add lands an in-window lockfile entry without the exclusion
  // pnpm writes for explicit-version installs — every cooldown-respecting
  // tool (the official manager's installs and removals) would trip over it
  // until the entry ages out. Write the same exclusion to heal the profile.
  const resolvedVersion = target === undefined ? undefined : readInstalledVersion(profileDirPath, target.name)
  if (ok && bypass && target?.name !== undefined && resolvedVersion !== null && resolvedVersion !== undefined) {
    try {
      appendCooldownExclusion(profileDirPath, target.name, resolvedVersion)
    } catch { /* best effort — the audit self-heals in 24h regardless */ }
  }
  // The paused generation resumes here: a successful swap recomposes the
  // rows against the new package (fresh resolution, new code live, no
  // restart); a failed swap restores the old generation as-is.
  if (isUpdate && paused?.lease !== undefined) {
    if (ok) {
      const reloaded = await paused.lease.resume()
      hot = reloaded.hot
      hotNote = reloaded.note
    } else {
      paused.lease.restore()
    }
  }
  return {
    ok,
    hot,
    hotNote,
    cancelled: result.cancelled || undefined,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    error: commandErrorText(result),
    staleRegistry: (!ok && smellsLikeStaleRegistry(result.stderr)) || undefined,
    resolvedVersion,
    expectedVersion: target?.expectedVersion,
    stdout: result.stdout.slice(-2000),
    stderr: result.stderr.slice(-2000),
    installed: readInstalledBundles(profileDirPath),
    live: listHotMounts(),
  }
}

/** Remove an installed plugin by name. The cooldown bypass makes this the
 * working removal channel wherever pnpm policy-checks the whole lockfile and
 * refuses — notably DSH Desktop, whose bundled pnpm audits every operation
 * and ignores the exclusion list, so the official page's 卸载 fails for as
 * long as any lockfile entry is inside the publish window. */
export async function uninstallPlugin(
  host: InstallerHost,
  profile: string,
  profileDirPath: string,
  name: string,
  timeouts: HotReloadTimeouts = {},
): Promise<InstallOutcome> {
  // The patch file disappears with the package, so read the rows before the
  // remove; leftover disable rows would ambush a future reinstall of the name.
  const mountRows = readMountRows(profileDirPath, name)
  // Pre-removal dependency inventory: the official reconciler decides which
  // ledger rows may drop by diffing the dependency sets across the removal.
  const before = await capturePluginInventory(profileDirPath)
  // Pause the running generation first, exactly like an update: the removal
  // deletes the package tree, and a live fs.watch handle over any of its
  // directories makes Windows refuse the deletion mid-way — the gutted
  // package. Never for the installer itself (the pause would tear down the
  // fiber serving this very request; the files of a removed-but-running
  // instance stay untouched in memory until the restart).
  const paused = name === SELF_NAME ? null : await pauseForSwap(host, profileDirPath, name, timeouts)
  if (paused?.blocked !== undefined) {
    return {
      ok: false,
      hot: false,
      exitCode: 1,
      timedOut: false,
      error: `${paused.blocked}; restart dsh, then uninstall again`,
      stdout: '',
      stderr: paused.blocked,
      installed: readInstalledBundles(profileDirPath),
      live: listHotMounts(),
    }
  }
  // A non-toggleable patch (or nothing row-targetable) pauses nothing; when
  // the plugin is nonetheless RUNNING, a package removal races its live
  // fs.watch handles and dies mid-removal (the gutted package — Windows
  // refuses deleting watched directories). Refuse and ask for the restart
  // that leaves nothing watching; a not-running plugin removes cleanly.
  if (paused === null && name !== SELF_NAME && liveFibersForPackage(host, name) > 0) {
    return {
      ok: false,
      hot: false,
      exitCode: 1,
      timedOut: false,
      error: 'this plugin is running and its mount rows cannot be paused individually; restart dsh, then uninstall again',
      stdout: '',
      stderr: 'live plugin with non-pausable mount rows',
      installed: readInstalledBundles(profileDirPath),
      live: listHotMounts(),
    }
  }
  // Same cooldown bypass as adds: pnpm 11 policy-checks the whole lockfile
  // on removes too, so an in-window entry anywhere blocks the uninstall.
  const { result } = await runOpWithBypass(profile, ['remove', name])
  const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled
  let integrity: InstallOutcome['integrity']
  if (ok) {
    invalidateUpdates()
    stripPluginRows(profileDirPath, mountRows)
    // Strike the dead ledger row before anything reboots: a bundle list
    // naming a removed package is a boot order to import a ghost — the
    // "import failed" crash, and on the desktop a profile-reset recovery.
    await reconcileRemovedPlugin(profileDirPath, name, before)
    // The removal may have pruned hoisted entries a remaining plugin was
    // silently resolving against (peers riding a neighbour's copy); repair
    // what an explicit install can fix before reporting success.
    integrity = await repairTreeIntegrity(profile, profileDirPath)
  } else {
    // The package survived: bring its paused generation back.
    paused?.lease?.restore()
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
    integrity,
    stdout: result.stdout.slice(-2000),
    stderr: result.stderr.slice(-2000),
    installed: readInstalledBundles(profileDirPath),
    live: listHotMounts(),
  }
}

/**
 * Audit every remaining profile-tree plugin's resolvable requirements after
 * a removal and re-install the ones a cooldown-bypassed add can satisfy.
 * Client injects are runtime-owned and only ever reported. Returns undefined
 * when the tree is clean and nothing was attempted.
 */
async function repairTreeIntegrity(profile: string, profileDirPath: string): Promise<InstallOutcome['integrity']> {
  const issues = auditProfileTree(profileDirPath, readInstalledBundles(profileDirPath))
  if (issues.length === 0) return undefined
  const repaired = new Set<string>()
  for (const issue of repairableIssues(issues)) {
    const { result } = await runOpWithBypass(profile, ['add', `${issue.requirement}@${issue.range}`])
    if (result.exitCode === 0 && !result.timedOut && !result.cancelled) repaired.add(issue.requirement)
  }
  const broken = auditProfileTree(profileDirPath, readInstalledBundles(profileDirPath))
  if (repaired.size === 0 && broken.length === 0) return undefined
  return {
    repaired: [...repaired],
    broken: broken.map(({ plugin, requirement }) => ({ plugin, requirement })),
  }
}

export { progress, cancelActive, inDesktop }
export type { InstallerHost } from './types.ts'