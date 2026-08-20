/**
 * Update-count badge for the Settings → Plugins nav row.
 *
 * The settings shell projects its section ledger into navigation through
 * STRING labels only (`resolveSlotLabel`), and the 插件 section belongs to
 * the host — a plugin cannot attach anything to another entry's slot
 * registration. The badge therefore rides the DOM directly (the same layer
 * atlas uses for its input history): a MutationObserver keeps a count pill
 * next to the localized 插件/Plugins label whenever the settings panel is
 * open, and repaints whenever React rebuilds the nav.
 */

/** The plugins-section nav label, zh and en — the only locales the host ships. */
const LABELS = new Set(['插件', 'Plugins'])

const CSS = `
.dpi-navBadge{flex:none;margin-left:2px;min-width:18px;height:18px;box-sizing:border-box;border-radius:999px;padding:0 5px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent);color:var(--dsw-alias-state-success-primary);font-size:11px;line-height:16px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums}
`

let count = 0
let observer: MutationObserver | null = null
let style: HTMLStyleElement | null = null
let scheduled = 0

function paint(): void {
  document.querySelectorAll('span[data-dpi-badge]').forEach(element => { element.remove() })
  if (count <= 0 || observer === null) return
  for (const label of Array.from(document.querySelectorAll<HTMLElement>('button span'))) {
    const text = label.textContent?.trim()
    if (text === undefined || !LABELS.has(text)) continue
    // The label span is the flex-growing last child of its nav cell; the
    // badge lands after it, right-aligned inside the cell.
    const cell = label.parentElement
    if (cell === null || cell.tagName !== 'BUTTON') continue
    const badge = document.createElement('span')
    badge.className = 'dpi-navBadge'
    badge.dataset.dpiBadge = ''
    badge.textContent = String(count)
    cell.appendChild(badge)
  }
}

function schedule(): void {
  window.clearTimeout(scheduled)
  scheduled = window.setTimeout(paint, 150)
}

/** Mount the badge layer; the disposer removes every trace on plugin unload. */
export function installNavBadge(): () => void {
  style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
  observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  paint()
  return () => {
    window.clearTimeout(scheduled)
    observer?.disconnect()
    observer = null
    style?.remove()
    style = null
    document.querySelectorAll('span[data-dpi-badge]').forEach(element => { element.remove() })
  }
}

/** Publish the updatable-plugin count; 0 (or less) hides the badge. */
export function setNavBadgeCount(value: number): void {
  count = value
  if (observer !== null) paint()
}
