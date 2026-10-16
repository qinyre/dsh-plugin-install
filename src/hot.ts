/**
 * Restart-free installs: mount a freshly installed plugin into the running
 * composition through an installer-owned Include subtree.
 *
 * Durable state stays with the profile's `dsh.profile.bundles`; this subtree
 * exists only for the current process. Input files live under
 * `<profile>/.dsh-plugin-install/` and are wiped on every boot, so a crash
 * can never leave a file colliding with the bundle layer.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readDisabledIds, readMountRows, setPluginMounted } from './mounts.ts'
import { dshCliAnchor } from './cli.ts'
import type { InstallerHost } from './types.ts'

interface HotRow {
  id: string
  name: string
}

interface HotContext {
  plugin(plugin: unknown, config: unknown): { await(): Promise<unknown>; dispose(): Promise<unknown> | void }
}

const HOT_DIR = '.dsh-plugin-install'

let hotTreeClass: unknown | null | undefined

/**
 * The Include subclass, built once per process; null when the loader's include
 * plugin is not importable — callers fall back to restart.
 * The Include subclass suppresses `write()` — the loader otherwise persists
 * tree changes back to the file it read.
 */
async function loadHotTreeClass(): Promise<unknown | null> {
  if (hotTreeClass !== undefined) return hotTreeClass
  try {
    const specifier = '@deepseek-ai/cordis-plugin-include'
    const mod = (await import(specifier)) as {
      Include?: new (...args: never[]) => { write(): void; import(name: string, getOuterStack?: () => string[]): unknown }
    }
    const Include = mod.Include
    if (Include === undefined) throw new Error('no Include export')
    class InstallerHotTree extends Include {
      /** Runtime-only mount list; the bundle layer owns persistence. */
      override write(): void {}
    }
    hotTreeClass = InstallerHotTree
  } catch {
    hotTreeClass = null
  }
  return hotTreeClass
}

/**
 * Insert rows of a plugin's bundle patch, or null when the patch contains
 * anything beyond plain `id`/`name` insert rows — those compositions fall
 * back to restart activation.
 */
export function parseSimplePatch(patchText: string): HotRow[] | null {
  const rows: HotRow[] = []
  let pending: string | null = null
  for (const raw of patchText.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (line.trim() === '') continue
    if (/^-\s+insert:\s*$/.test(line)) continue
    const id = /^\s+-\s+id:\s*(\S+)\s*$/.exec(line)
    if (id !== null) {
      if (pending !== null) return null
      pending = id[1]
      continue
    }
    const name = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line)
    if (name !== null && pending !== null) {
      rows.push({ id: pending, name: name[1] })
      pending = null
      continue
    }
    return null
  }
  if (pending !== null || rows.length === 0) return null
  return rows
}

/** Wipe leftover hot-mount inputs; call once when the installer starts. */
export function cleanHotDir(profileDirPath: string): void {
  const dir = join(profileDirPath, HOT_DIR)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (/^hot-\d+\.yml$/.test(name)) rmSync(join(dir, name), { force: true })
  }
}

let mountCounter = 0

/** Package names hot-mounted into the LIVE composition this process. */
const liveMounts = new Set<string>()

/**
 * Hot-mount one plugin's rows into the live composition. Returns false when
 * the mount is not possible (no Include class) or the subtree failed to
 * start — the caller then tells the user to restart.
 */
export async function hotMount(
  host: HotContext,
  profileDirPath: string,
  packageName: string,
  rows: HotRow[],
): Promise<boolean> {
  const TreeClass = await loadHotTreeClass() as (new (files: string[], options: unknown) => { import(name: string): unknown }) | null
  if (TreeClass === null) return false
  const dir = join(profileDirPath, HOT_DIR)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `hot-${++mountCounter}.yml`)
  const yaml = `- insert:\n${rows.map(row => `    - id: ${row.id}\n      name: ${row.name}`).join('\n')}\n`
  writeFileSync(file, yaml, 'utf8')
  try {
    const tree = new TreeClass([file], null)
    const fiber = host.plugin(tree, undefined)
    await fiber.await()
    liveMounts.add(packageName)
    return true
  } catch {
    return false
  }
}

/** Package names hot-mounted into the live composition this process. */
export function listHotMounts(): string[] {
  return [...liveMounts]
}

/** Unmount a hot mount by package name. */
export async function hotUnmount(packageName: string): Promise<boolean> {
  return liveMounts.delete(packageName)
}

/** How long the unload and re-activation legs of a hot reload may each take. */
const UNLOAD_TIMEOUT_MS = 10_000
const LOAD_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 250

/** Tunables for tests; production uses the defaults. */
export interface HotReloadTimeouts {
  unloadTimeoutMs?: number
  loadTimeoutMs?: number
}

export interface HotReloadResult {
  /** True when the recomposed fibers run the updated code. */
  hot: boolean
  /** Why a false result is still restart-worthy, when one applies. */
  note?: string
}

/** A plugin paused for an on-disk swap: `resume` brings the new code live. */
export interface SwapLease {
  /** Re-enable the paused rows and wait for the recomposed fibers. */
  resume(timeouts?: HotReloadTimeouts): Promise<HotReloadResult>
  /** Re-enable the paused rows without waiting (the swap failed). */
  restore(): void
}

/** Number of the package's row entries whose root fiber is live. */
function liveRowCount(host: InstallerHost, ids: readonly string[]): number {
  let live = 0
  for (const entry of host.loaderEntries()) {
    if (entry?.options === undefined || entry.fiber === undefined || entry.fiber === null) continue
    // Disposed/failed fibers stay parked on their entry (cordis keeps them
    // for introspection) — only pending/active ones are running code. The
    // numeric states mirror cordis's const enum (0 pending, 2 active,
    // 3 failed, 4 disposed); aligned with app-boot's own mirrors.
    const state = (entry.fiber as { state?: unknown }).state
    if (state === 3 || state === 4) continue
    if (ids.includes(entry.options.id ?? '')) live += 1
  }
  return live
}

/** Live fibers belonging to a package by name — entries carry the package
 * name alongside their row id, so a plugin whose mount rows resist per-row
 * targeting (a non-toggleable patch) is still visible as running. */
export function liveFibersForPackage(host: InstallerHost, name: string): number {
  let live = 0
  for (const entry of host.loaderEntries()) {
    if (entry?.options === undefined || entry.fiber === undefined || entry.fiber === null) continue
    const state = (entry.fiber as { state?: unknown }).state
    if (state === 3 || state === 4) continue
    if (entry.options.name === name) live += 1
  }
  return live
}

async function waitForRowCount(
  host: InstallerHost,
  ids: readonly string[],
  predicate: (count: number) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate(liveRowCount(host, ids))) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => { setTimeout(resolve, POLL_INTERVAL_MS) })
  }
}

/**
 * Pause one running plugin before its package is swapped on disk. Unmounting
 * first matters on Windows: plugins holding fs.watch handles (skill roots,
 * vendored directories) keep those directories undeletable, so a swap that
 * races a live watcher dies mid-removal and guts the package. Pausing
 * disposes the fibers — closing every watcher — before pnpm touches
 * anything; `resume` then re-enables the rows, and the recompose resolves
 * the swapped package afresh (a URL the loader has never cached), importing
 * the new code as the replacement generation.
 *
 * Manual mounting intentionally clears every targeted disable directive;
 * only rows enabled before the pause are touched, preserving per-row pauses
 * (home-layer pauses and foreign managers' configuration).
 *
 * Returns null when there is nothing to pause (not toggleable, or nothing of
 * it is currently running); `blocked` names a pause failure with the rows
 * already restored.
 */
/** The two app-boot entry points the official plugin-manager itself uses to
 * recompose the live profile tree (its reload() is exactly this call). */
interface AppBootReconcile {
  readProfilePatches(binName: string, context: unknown): unknown[]
  reconcileProfilePatches(ctx: unknown, patches: unknown[], binName: string, requiredIds?: string[]): Promise<unknown>
}

let appBoot: AppBootReconcile | null | undefined

/** Resolve the host's own app-boot copy, anchored at the CLI entry this host
 * booted from (the same scan dshArgv uses — including the desktop's
 * asar-packed runtime). Only the host's copy reconciles against the live
 * Include map: any other copy (a dev checkout's node_modules, say) throws on
 * a foreign map, so no plain-specifier fallback exists. Null when nothing
 * resolves (0.1.x hosts, unusual launches). */
async function loadAppBoot(): Promise<AppBootReconcile | null> {
  if (appBoot !== undefined) return appBoot
  const anchor = dshCliAnchor()
  if (anchor !== undefined) {
    try {
      const file = createRequire(anchor.entry).resolve('@deepseek-ai/dsh-app-boot')
      const mod = (await import(pathToFileURL(file).href)) as Partial<AppBootReconcile>
      appBoot = typeof mod.reconcileProfilePatches === 'function' && typeof mod.readProfilePatches === 'function'
        ? (mod as AppBootReconcile)
        : null
    } catch {
      appBoot = null
    }
  } else {
    appBoot = null
  }
  return appBoot
}

/** Apply a row change to the LIVE tree the way the official manager does:
 * read the profile patches fresh from disk and reconcile them against the
 * root context — nothing watches the patch file in a plain web boot (the
 * dsh-hmr watcher only arms when its service wakes), so an explicit
 * reconcile is what actually recomposes the fibers. Falls back to touching
 * the hmr service (arming its watcher) on hosts without app-boot access. */
async function applyRowChange(host: InstallerHost, requiredIds: readonly string[] = []): Promise<void> {
  const profile = host.service?.('profileContext')
  const boot = await loadAppBoot()
  const root = host.root
  if (boot !== null && profile !== undefined && root !== undefined) {
    try {
      await boot.reconcileProfilePatches(root, boot.readProfilePatches('dsh', profile), 'dsh', [...requiredIds])
      return
    } catch { /* the poll decides */ }
  }
  host.service?.('hmr')
}

export async function pauseForSwap(
  host: InstallerHost,
  profileDirPath: string,
  name: string,
  timeouts: HotReloadTimeouts = {},
): Promise<{ lease?: SwapLease; blocked?: string } | null> {
  const rows = readMountRows(profileDirPath, name)
  if (!rows.toggleable) return null
  const disabledBefore = readDisabledIds(profileDirPath)
  const swapRows = { ...rows, ids: rows.ids.filter(id => !disabledBefore.has(id)) }
  const liveBefore = liveRowCount(host, swapRows.ids)
  if (liveBefore === 0) return null
  setPluginMounted(profileDirPath, swapRows, false)
  await applyRowChange(host)
  let unloaded: boolean
  try {
    unloaded = await waitForRowCount(
      host, swapRows.ids, count => count === 0,
      timeouts.unloadTimeoutMs ?? UNLOAD_TIMEOUT_MS,
    )
  } catch (error) {
    setPluginMounted(profileDirPath, swapRows, true)
    throw error
  }
  if (!unloaded) {
    setPluginMounted(profileDirPath, swapRows, true)
    await applyRowChange(host)
    await waitForRowCount(host, swapRows.ids, count => count >= liveBefore, timeouts.loadTimeoutMs ?? LOAD_TIMEOUT_MS)
    return { blocked: 'the running plugin did not pause in time' }
  }
  const lease: SwapLease = {
    restore(): void {
      setPluginMounted(profileDirPath, swapRows, true)
    },
    async resume(resumeTimeouts: HotReloadTimeouts = {}): Promise<HotReloadResult> {
      lease.restore()
      await applyRowChange(host, swapRows.ids)
      const reloaded = await waitForRowCount(
        host, swapRows.ids, count => count >= liveBefore,
        resumeTimeouts.loadTimeoutMs ?? timeouts.loadTimeoutMs ?? LOAD_TIMEOUT_MS,
      )
      if (!reloaded) {
        return { hot: false, note: 'the updated plugin did not finish activating in time; restart to retry' }
      }
      return { hot: true }
    },
  }
  return { lease }
}

/**
 * Hot-reload one updated plugin whose swap already happened: pause its rows
 * and resume them, so the watched profile layer recomposes the entries
 * against the new on-disk package. Restoration restores the rows either
 * way; a failed leg degrades to restart semantics.
 *
 * Returns null when there is nothing to hot-reload: the plugin is not
 * toggleable or nothing of it is currently running.
 */
export async function hotReloadUpdate(
  host: InstallerHost,
  profileDirPath: string,
  name: string,
  timeouts: HotReloadTimeouts = {},
): Promise<HotReloadResult | null> {
  const paused = await pauseForSwap(host, profileDirPath, name, timeouts)
  if (paused === null) return null
  if (paused.blocked !== undefined) {
    return { hot: false, note: 'the previous generation did not unload in time; restart to activate the update' }
  }
  return paused.lease!.resume(timeouts)
}
