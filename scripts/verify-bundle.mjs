/**
 * Verify the built artifacts. The client bundle must register with the
 * loader under the plugin id and keep every platform module external (no
 * bundled react / no cross-plugin @deepseek-ai value imports). The node
 * bundle must actually import: a bundled CommonJS dependency with dynamic
 * `require()` calls (yaml) crashes at module init in ESM output — exactly
 * the class of defect a static check cannot see.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(root, 'lib', 'client.js')
const bundle = readFileSync(bundlePath, 'utf8')

const failures = []
if (!bundle.includes('window.__ModuleLoader__.load({ id: "dsh-plugin-install"')) {
  failures.push('bundle does not start with the loader registration for dsh-plugin-install')
}
for (const module of ['react', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/cordis']) {
  // Externals appear as require("...") calls, never inlined. A platform
  // dependency used only as a type is erased at build time and absent
  // entirely — that is equally correct (nothing to fetch at runtime).
  if (bundle.includes(`require("${module}")`)) continue
  if (!bundle.includes(module)) continue
  failures.push(`platform module "${module}" leaked into the bundle (should be external or type-erased)`)
}
if (failures.length === 0) {
  try {
    await import(`file://${join(root, 'lib', 'index.js').replaceAll('\\', '/')}`)
  } catch (error) {
    failures.push(`node bundle fails to import: ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  process.exit(1)
}
console.log('[dsh-plugin-install] client bundle artifact verified')