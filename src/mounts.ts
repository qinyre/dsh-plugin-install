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
 *
 * Layer files are rewritten through the YAML document tree, never by string
 * surgery: dsh itself writes rows in flow style (`[ { id: … } ]` — the MCP
 * config rows), and 0.3.0 appending block-style rows after a flow-style root
 * produced unparseable YAML that killed the live recompose and bricked the
 * next boot. Rows this plugin owns carry a per-row comment marker so they
 * stay identifiable under any formatting.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse, parseDocument, YAMLMap, YAMLSeq, type Document, type ParsedNode } from 'yaml'
import { dshHome } from './profile.ts'

/** Profile-level user patch layer, hot-reloaded on long-lived surfaces. */
export const PROFILE_PATCH_FILE = 'cordis.patch.yml'

/** Per-row comment marking the rows this plugin owns. */
const MANAGED_MARK = 'dsh-plugin-install mount'

/** Markers of the 0.3.0 line-surgery format; their block is dropped when a
 * file it produced no longer parses (block rows appended after a flow-style
 * root made the whole file unparseable). */
const LEGACY_BEGIN = '# begin dsh-plugin-install mounts (managed)'
const LEGACY_END = '# end dsh-plugin-install mounts'

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
 * Parse a patch layer into its document. The root must be a YAML list (a
 * comments-only file counts as an empty one); anything else, or text that
 * does not parse even after dropping the legacy managed block, yields null.
 * Note `parseDocument` collects syntax errors on the document instead of
 * throwing — check `errors`, and never stringify such a document.
 */
function parseLayer(text: string): Document | null {
  for (const candidate of [text, stripLegacyBlock(text)]) {
    const doc = parseDocument(candidate)
    if (doc.errors.length > 0) continue
      if (doc.contents === null) {
        // A fresh node carries no source range until first stringified; the
        // parsed-contents type demands one, hence the cast.
        doc.contents = new YAMLSeq<ParsedNode>() as never
        return doc
      }
    if (doc.contents instanceof YAMLSeq) return doc
    return null
  }
  return null
}

/** The file minus the legacy marker block: markers and the rows between them. */
function stripLegacyBlock(text: string): string {
  const kept: string[] = []
  let inside = false
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === LEGACY_BEGIN) { inside = true; continue }
    if (trimmed === LEGACY_END) { inside = false; continue }
    if (!inside) kept.push(line)
  }
  return kept.join('\n')
}

/**
 * Ids disabled by a bare `{ id, disabled: true }` row — the managed rows and
 * any hand-written ones share this shape, in either YAML style.
 */
export function scanDisabledIds(patchText: string): Set<string> {
  const disabled = new Set<string>()
  const seq = parseLayer(patchText)?.contents
  if (!(seq instanceof YAMLSeq)) return disabled
  for (const item of seq.items) {
    if (!(item instanceof YAMLMap)) continue
    if (item.has('insert')) continue // created-row syntax, not a disable directive
    const id = item.get('id')
    if (typeof id === 'string' && item.get('disabled') === true) disabled.add(id)
  }
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

/**
 * True for rows this plugin owns. Primary signal: the per-row marker comment,
 * which survives re-parsing (even when a leading file comment merges into the
 * first row's commentBefore). Fallback signal: the exact managed shape
 * `{ id, disabled: true }` — nothing else writes rows that minimal.
 */
function isManagedRow(item: unknown): item is YAMLMap {
  if (!(item instanceof YAMLMap)) return false
  if (String(item.commentBefore ?? '').includes(MANAGED_MARK)) return true
  const keys = item.items.map(pair => String(pair.key))
  return keys.length === 2 && keys.includes('id') && keys.includes('disabled') && item.get('disabled') === true
}

/**
 * The row ids this plugin currently owns in the profile layer — marked rows,
 * plus whatever sits inside a legacy 0.3.0 marker block, so a rescue rewrite
 * restores the paused state instead of silently re-enabling every plugin.
 */
function readManagedIds(patchFile: string): string[] {
  if (!existsSync(patchFile)) return []
  const text = readFileSync(patchFile, 'utf8')
  const ids: string[] = [...legacyBlockIds(text)]
  const seq = parseLayer(text)?.contents
  if (seq instanceof YAMLSeq) {
    for (const item of seq.items) {
      if (!isManagedRow(item)) continue
      const id = item.get('id')
      if (typeof id === 'string' && !ids.includes(id)) ids.push(id)
    }
  }
  return ids
}

/** Ids inside a legacy marker block, when one is present. */
function legacyBlockIds(text: string): string[] {
  const begin = text.indexOf(LEGACY_BEGIN)
  const end = text.indexOf(LEGACY_END)
  if (begin === -1 || end === -1 || end < begin) return []
  return [...scanDisabledIds(text.slice(begin, end + LEGACY_END.length))]
}

/** Comment lines that belong to this plugin's bookkeeping, not the user. */
function isMarkerCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed === MANAGED_MARK
    || trimmed === LEGACY_BEGIN.slice(2)
    || trimmed === LEGACY_END.slice(2)
}

/**
 * Rewrite the layer so the managed rows are exactly `ids`. Everything else —
 * comments, rows in either style — carries over through the document tree,
 * and the whole file renders in block style, because a flow-style root
 * cannot take block-style appends (the 0.3.0 failure). The composed output
 * is verified to parse before anything is written.
 */
export function writeManagedBlock(patchFile: string, ids: string[]): void {
  const text = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  const doc = parseLayer(text)
  if (doc === null) {
    throw new Error(`cannot rewrite ${patchFile}: not a YAML list of patch rows`)
  }
  const seq = doc.contents as YAMLSeq
  setBlockStyle(seq)
  // A comment directly above the first row re-attaches to that row on
  // parse, so dropping managed rows would take leading file comments with
  // them; rescue those lines back to the list head instead.
  const rescuedComments: string[] = []
  seq.items = seq.items.filter(item => {
    if (!isManagedRow(item)) return true
    for (const line of String(item.commentBefore ?? '').split('\n')) {
      if (line.trim() !== '' && !isMarkerCommentLine(line)) rescuedComments.push(line)
    }
    return false
  })
  if (rescuedComments.length > 0) {
    const head = seq.commentBefore?.split('\n') ?? []
    seq.commentBefore = [...head, ...rescuedComments].join('\n')
  }
  for (const id of [...new Set(ids)].sort()) {
    const row = new YAMLMap()
    row.set('id', id)
    row.set('disabled', true)
    row.commentBefore = ` ${MANAGED_MARK}`
    seq.items.push(row)
  }
  const content = doc.toString({ lineWidth: 0 })
  // The live watcher re-reads this file on every change and fails loud on
  // anything else; never write what it could not parse.
  parse(content)
  writeFileInPlace(patchFile, content)
}

/** Render every collection in block style; scalar values re-quote as needed. */
function setBlockStyle(node: unknown): void {
  if (node instanceof YAMLMap) {
    node.flow = false
    for (const pair of node.items) setBlockStyle(pair.value)
  } else if (node instanceof YAMLSeq) {
    node.flow = false
    for (const item of node.items) setBlockStyle(item)
  }
}

/**
 * Write the file in place. An atomic temp+rename swap would be invisible to
 * chokidar — the rename replaces the watched inode and no change event ever
 * fires (verified against the HMR watcher's own chokidar) — while an
 * in-place write reliably emits the event the live recompose depends on.
 * chokidar re-reads the file when handling the event, not when raising it,
 * so a single write syscall is never observed half-done.
 */
function writeFileInPlace(file: string, content: string): void {
  try {
    writeFileSync(file, content, 'utf8')
  } catch (error) {
    throw new Error(`cannot write ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Toggle one plugin's mount: unmounted = every row id the bundle inserts
 * lands in the managed rows; mounted = they leave it. The profile layer's
 * watcher recomposes the tree live; without a watcher the next boot honors
 * the rows.
 */
export function setPluginMounted(profileDirPath: string, rows: MountRows, mounted: boolean): void {
  const patchFile = join(profileDirPath, PROFILE_PATCH_FILE)
  const others = readManagedIds(patchFile).filter(id => !rows.ids.includes(id))
  writeManagedBlock(patchFile, mounted ? others : [...others, ...rows.ids])
}

/**
 * Drop a plugin's rows from the managed set — the uninstall path, so a
 * stale disable never ambushes a future reinstall of the same package.
 */
export function stripPluginRows(profileDirPath: string, rows: MountRows): void {
  const patchFile = join(profileDirPath, PROFILE_PATCH_FILE)
  const managed = readManagedIds(patchFile)
  if (!rows.ids.some(id => managed.includes(id))) return
  writeManagedBlock(patchFile, managed.filter(id => !rows.ids.includes(id)))
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
