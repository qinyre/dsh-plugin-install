/**
 * Mount toggling: pause a plugin's composition rows without uninstalling it.
 *
 * dsh composes every profile from patch layers — bundle layers in
 * `dsh.profile.bundles` order, then the profile's own `cordis.patch.yml`,
 * then the home-level layer — and a bare patch row `{ id, disabled: true }`
 * MERGES that flag onto an existing entry (same mechanism the
 * DSH_TELEMETRY_DISABLED switch uses). The user layers are watched live
 * (`watchUserPatches`), so writing the row unmounts the plugin immediately
 * and survives reboots, while the bundle list — and therefore the
 * `dsh plugin` reconciler — never changes.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './profile.ts'

/** Profile-level user patch layer, hot-reloaded on long-lived surfaces. */
export const PROFILE_PATCH_FILE = 'cordis.patch.yml'

/** Managed-block markers; everything between them is ours to rewrite. */
const BEGIN_MARK = '# begin dsh-plugin-install mounts (managed)'
const END_MARK = '# end dsh-plugin-install mounts'

/** Row ids are loader slugs; anything fancier would need YAML quoting we do not do. */
const SAFE_ID = /^[A-Za-z0-9_.@/-]+$/

export interface MountRows {
  /** Entry rows the bundle's patch inserts — disabling all of them pauses the plugin. */
  ids: string[]
  /** False when the patch has rows we cannot target (no id, or a group row). */
  toggleable: boolean
}

const NOT_TOGGLEABLE: MountRows = { ids: [], toggleable: false }

/**
 * Collect the entry-row ids a bundle patch CREATES. Rows merely modified by
 * bare rows (a patch row with `id` + other keys but no `insert`) belong to
 * someone else and must not be disabled. Group rows cannot be disabled at
 * all (the loader's `disabled` getter returns false for groups), so any
 * group inside an insert list makes the whole plugin non-toggleable.
 */
export function collectInsertIds(patchText: string): MountRows {
  const ids: string[] = []
  const lines = patchText.split(/\r?\n/)
  // Indent of the `insert:` key whose child rows we are reading; -1 outside.
  let insertIndent = -1
  // The row under construction: its id, and whether it declared `group`.
  let pendingId: string | null = null
  let pendingGroup = false
  let sawRow = false
  let groupSeen = false

  const flushRow = (): void => {
    if (pendingId === null && !pendingGroup) return
    sawRow = true
    if (pendingId !== null && !pendingGroup) ids.push(pendingId)
    if (pendingGroup) groupSeen = true
    pendingId = null
    pendingGroup = false
  }

  for (const raw of lines) {
    const line = raw.replace(/(^|\s)#.*$/, '').replace(/\s+$/, '')
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length

    if (insertIndent >= 0 && indent <= insertIndent) {
      flushRow()
      insertIndent = -1
    }

    if (insertIndent >= 0) {
      const trimmed = line.trim()
      if (trimmed.startsWith('- ')) {
        flushRow()
        const inline = /^id:\s*(.+)$/.exec(trimmed.slice(2).trim())
        if (inline !== null) pendingId = stripQuotes(inline[1])
        if (/^group:\s*(.+)$/.test(trimmed.slice(2).trim())) pendingGroup = true
        continue
      }
      const key = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(trimmed)
      if (key !== null) {
        if (key[1] === 'id' && pendingId === null) pendingId = stripQuotes(key[2])
        if (key[1] === 'group') pendingGroup = true
        if (key[1] === 'insert') {
          // A created row carrying its own insert list: treat its line as the
          // new block anchor so the children are collected too.
          flushRow()
          insertIndent = indent
        }
        continue
      }
      continue
    }

    if (/^(-\s+)?insert:\s*$/.test(line.trim())) insertIndent = indent
  }
  flushRow()

  if (!sawRow) return NOT_TOGGLEABLE
  if (groupSeen) return NOT_TOGGLEABLE
  if (ids.length === 0 || !ids.every(id => SAFE_ID.test(id))) return NOT_TOGGLEABLE
  return { ids, toggleable: true }
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1)
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1)
  return trimmed
}

/**
 * Ids disabled by a bare `{ id, disabled: true }` row — the managed rows and
 * any hand-written ones share this shape. Line-based by design: these files
 * are plain top-level lists; full YAML parsing is out of scope for a scanner.
 */
export function scanDisabledIds(patchText: string): Set<string> {
  const disabled = new Set<string>()
  let currentId: string | null = null
  let currentDisabled = false
  let hasInsert = false
  const flushRow = (): void => {
    if (currentId !== null && currentDisabled && !hasInsert) disabled.add(currentId)
    currentId = null
    currentDisabled = false
    hasInsert = false
  }
  for (const raw of patchText.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').replace(/\s+$/, '')
    if (line.trim() === '') continue
    if (line.trim().startsWith('#')) continue
    // Normalize a row start `- id: x` into the same `  key: value` shape its
    // continuation lines use, so inline keys parse identically.
    const body = line.startsWith('- ') ? `  ${line.slice(2).trimStart()}` : line
    if (line.startsWith('- ')) flushRow()
    if (body.startsWith('  ')) {
      const trimmed = body.trim()
      if (trimmed === 'insert:') {
        hasInsert = true
        continue
      }
      const key = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(trimmed)
      if (key !== null) {
        if (key[1] === 'id') currentId = stripQuotes(key[2])
        if (key[1] === 'disabled') currentDisabled = key[2].trim().toLowerCase() === 'true'
        if (key[1] === 'insert') hasInsert = true
      }
    }
  }
  flushRow()
  return disabled
}

/** The disabled-row id set across the profile and home user layers. */
export function readDisabledIds(profileDirPath: string, home = dshHome()): Set<string> {
  const ids = new Set<string>()
  for (const file of [join(profileDirPath, PROFILE_PATCH_FILE), join(home, PROFILE_PATCH_FILE)]) {
    if (!existsSync(file)) continue
    try {
      for (const id of scanDisabledIds(readFileSync(file, 'utf8'))) ids.add(id)
    } catch { /* unreadable layer: boot owns the complaint */ }
  }
  return ids
}

interface ManagedBlock {
  /** File content before the begin marker. */
  before: string
  /** File content after the end marker. */
  after: string
  ids: string[]
}

/** Parse the managed block out of the profile patch file; null when absent. */
function readManagedBlock(patchFile: string): ManagedBlock | null {
  if (!existsSync(patchFile)) return null
  const text = readFileSync(patchFile, 'utf8')
  const begin = text.indexOf(BEGIN_MARK)
  const end = text.indexOf(END_MARK)
  if (begin === -1 || end === -1 || end < begin) return null
  return {
    before: text.slice(0, begin),
    after: text.slice(end + END_MARK.length),
    ids: [...scanDisabledIds(text.slice(begin, end))],
  }
}

/**
 * Rewrite the managed block so `ids` are exactly the disabled ones. User rows
 * outside the markers stay byte-for-byte, and the write lands in place — the
 * live watcher's chokidar never sees a rename swap. With no rows left the
 * block disappears entirely.
 */
export function writeManagedBlock(patchFile: string, ids: string[]): void {
  const existing = readManagedBlock(patchFile)
  // Without a managed block yet, the whole file is user content and stays;
  // with one, only the content outside the markers carries over.
  const carry = existing === null
    ? (existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '')
    : existing.before + existing.after
  // A seeded profile layer is comments plus a bare `[]` root — rows appended
  // after a flow-array document make the file unparsable, so that lone root
  // line is dropped while the header comments stay.
  const lines = carry.split(/\r?\n/)
  const rowLines = lines.filter(line => { const t = line.trim(); return t !== '' && !t.startsWith('#') })
  const stripRoot = rowLines.length === 1 && rowLines[0].trim() === '[]'
  const kept = stripRoot ? lines.filter(line => line.trim() !== '[]') : lines
  const body = kept.join('\n').replace(/\s*$/, '')
  const rows = [...new Set(ids)].sort()
  const block = rows.length === 0
    ? ''
    : `${BEGIN_MARK}\n${rows.map(id => `- id: ${id}\n  disabled: true`).join('\n')}\n${END_MARK}\n`
  // The layer file must always hold a top-level array: the live watcher
  // re-parses it on every change and fails loud on anything else, so a body
  // of comments alone (or nothing) gets an explicit empty root back.
  const bodyHasRows = rowLines.some(line => line.trim() !== '[]')
  const content = body === ''
    ? (block === '' ? '[]\n' : block)
    : block === ''
      ? (bodyHasRows ? `${body}\n` : `${body}\n[]\n`)
      : `${body}\n${block}`
  atomicWrite(patchFile, content)
}

/**
 * Write the file in place. An atomic temp+rename swap would be invisible to
 * chokidar — the rename replaces the watched inode and no change event ever
 * fires (verified against the HMR watcher's own chokidar) — while an
 * in-place write reliably emits the event the live recompose depends on.
 * chokidar re-reads the file when handling the event, not when raising it,
 * so a single write syscall is never observed half-done.
 */
function atomicWrite(file: string, content: string): void {
  try {
    writeFileSync(file, content, 'utf8')
  } catch (error) {
    throw new Error(`cannot write ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Toggle one plugin's mount: unmounted = every row id the bundle inserts
 * lands in the managed block; mounted = they leave it. The profile layer's
 * watcher recomposes the tree live; without a watcher the next boot honors
 * the rows.
 */
export function setPluginMounted(profileDirPath: string, rows: MountRows, mounted: boolean): void {
  const patchFile = join(profileDirPath, PROFILE_PATCH_FILE)
  const existing = readManagedBlock(patchFile)
  const others = (existing?.ids ?? []).filter(id => !rows.ids.includes(id))
  writeManagedBlock(patchFile, mounted ? others : [...others, ...rows.ids])
}

/**
 * Drop a plugin's rows from the managed block — the uninstall path, so a
 * stale disable never ambushes a future reinstall of the same package.
 */
export function stripPluginRows(profileDirPath: string, rows: MountRows): void {
  const patchFile = join(profileDirPath, PROFILE_PATCH_FILE)
  const existing = readManagedBlock(patchFile)
  if (existing === null) return
  writeManagedBlock(patchFile, existing.ids.filter(id => !rows.ids.includes(id)))
}

/**
 * The bundle patch text of an installed plugin, or null when the package or
 * its patch declaration cannot be read.
 */
export function readBundlePatch(profileDirPath: string, name: string): string | null {
  const manifestFile = join(profileDirPath, 'node_modules', name, 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { dsh?: { bundle?: { patch?: string } } }
    const patchPath = manifest.dsh?.bundle?.patch
    if (patchPath === undefined) return null
    const file = join(dirname(manifestFile), patchPath)
    if (!existsSync(file)) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Mount rows of an installed plugin; non-toggleable when its patch resists targeting. */
export function readMountRows(profileDirPath: string, name: string): MountRows {
  const patch = readBundlePatch(profileDirPath, name)
  if (patch === null) return NOT_TOGGLEABLE
  return collectInsertIds(patch)
}
