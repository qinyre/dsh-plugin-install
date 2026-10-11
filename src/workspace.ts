/**
 * The profile's `pnpm-workspace.yaml` holds pnpm's per-profile settings —
 * among them `minimumReleaseAgeExclude`, the list of `name@version` specs
 * exempted from the 24-hour release-age audit. pnpm appends an entry for
 * every explicitly versioned install; updates installed through our
 * cooldown bypass (`name@latest` + `--config.minimum-release-age=0`) land
 * in the lockfile WITHOUT one, and every cooldown-respecting operation —
 * the official manager's installs and removals — then fails
 * ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION until the entry ages out of the
 * window. Writing the same exclusion after a bypassed update keeps the
 * profile usable by every tool, not just ours.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, parseDocument, stringify, YAMLSeq } from 'yaml'

const WORKSPACE_FILE = 'pnpm-workspace.yaml'
const EXCLUDE_KEY = 'minimumReleaseAgeExclude'

/** The exact entry pnpm itself writes for explicit-version installs. */
export function cooldownExclusionEntry(name: string, version: string): string {
  return `${name}@${version}`
}

/**
 * Add one exclusion entry to the profile's `pnpm-workspace.yaml`, creating
 * the file when absent. Existing content (packages, allowBuilds, …) is
 * preserved through the document tree, duplicates are skipped, and the
 * output is verified to parse before writing — the file feeds every pnpm
 * operation in the profile.
 */
export function appendCooldownExclusion(profileDirPath: string, name: string, version: string): void {
  const file = join(profileDirPath, WORKSPACE_FILE)
  const entry = cooldownExclusionEntry(name, version)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const doc = parseDocument(text)
  if (doc.errors.length > 0) {
    throw new Error(`cannot update ${file}: not valid YAML (${doc.errors[0]?.message ?? 'parse error'})`)
  }
  let seq = doc.get(EXCLUDE_KEY)
  if (seq === undefined) {
    seq = new YAMLSeq()
    doc.set(EXCLUDE_KEY, seq)
  }
  if (!(seq instanceof YAMLSeq)) {
    throw new Error(`cannot update ${file}: ${EXCLUDE_KEY} is not a list`)
  }
  const known = new Set(seq.items.map(item => String(item)).filter(value => value !== 'null'))
  if (!known.has(entry)) seq.add(entry)
  const content = stringify(doc, { lineWidth: 0 })
  parse(content) // never write what pnpm could not read back
  // In-place write on purpose: a temp+rename swap can be invisible to
  // watchers, and pnpm re-reads this file on every operation.
  writeFileSync(file, content, 'utf8')
}
