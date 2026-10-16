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
const RELIEF_KEY = 'minimumReleaseAge'

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

/**
 * Whether this plugin's cooldown relief is active. pnpm 11 audits the WHOLE
 * lockfile against the 24-hour publish window on every operation, and the
 * desktop's bundled 11.7 ignores minimumReleaseAgeExclude — so whenever the
 * profile holds a freshly published version (every self-update), the
 * official manager's installs and removals all fail
 * ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION for a day. The relief writes
 * `minimumReleaseAge: 0` into the same workspace file every pnpm invocation
 * in the profile reads, project-level config overriding the default policy
 * for official-channel operations too (verified against bundled 11.7).
 */
export function readCooldownRelief(profileDirPath: string): boolean {
  const file = join(profileDirPath, WORKSPACE_FILE)
  if (!existsSync(file)) return false
  try {
    return parseDocument(readFileSync(file, 'utf8')).get(RELIEF_KEY) === 0
  } catch {
    return false
  }
}

/**
 * Enable or disable the relief. Enabling sets `minimumReleaseAge: 0`
 * (overwriting whatever the key held). Disabling removes the key — but only
 * the zero this plugin wrote; a foreign non-zero value is the user's own
 * policy and stays untouched, with the resulting off state reported.
 * Returns the resulting relief state.
 */
export function setCooldownRelief(profileDirPath: string, enabled: boolean): boolean {
  const file = join(profileDirPath, WORKSPACE_FILE)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const doc = parseDocument(text)
  if (doc.errors.length > 0) {
    throw new Error(`cannot update ${file}: not valid YAML (${doc.errors[0]?.message ?? 'parse error'})`)
  }
  const current = doc.get(RELIEF_KEY)
  if (enabled) {
    doc.set(RELIEF_KEY, 0)
  } else if (current === undefined || current === 0) {
    doc.delete(RELIEF_KEY)
  } else {
    return false
  }
  const content = stringify(doc, { lineWidth: 0 })
  parse(content) // never write what pnpm could not read back
  writeFileSync(file, content, 'utf8')
  return readCooldownRelief(profileDirPath)
}
