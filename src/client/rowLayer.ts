/**
 * List-row decorations on the Plugins page: an update dot on a card's icon
 * and an Update control beside its enable switch.
 *
 * The page declares no per-row slot — rows are the host's React output — so
 * this layer rides the DOM the way the nav badge does: a MutationObserver
 * keeps every `li[data-plugin-package]` (the page's own stable per-package
 * attribute) decorated while the page is open, and repaints from the shared
 * update store whenever React rebuilds a row or the store moves. The
 * official items (`data-plugin-item`) and bundle-row lists
 * (`data-plugin-row`) never match, so decoration stays on installable
 * packages.
 */

import { restartHost, snapshot, subscribe, updatePlugin, type OpState } from './store.ts'

/** The bound locale translator; label strings resolve at paint time so a
 * language switch repaints correctly. */
export type Translate = (key: string) => string

const DOT_CLASS = 'dpi-updateDot'
const BTN_CLASS = 'dpi-updateBtn'

let t: Translate = key => key

const CSS = `
.${DOT_CLASS}{position:absolute;top:-3px;right:-3px;width:10px;height:10px;border-radius:999px;background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1);pointer-events:none}
.${BTN_CLASS}{flex:none;display:inline-flex;align-items:center;min-height:24px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-state-success-primary);background:transparent;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:20px;font-weight:500;cursor:pointer;white-space:nowrap}
.${BTN_CLASS}:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.${BTN_CLASS}:disabled{opacity:.55;cursor:default}
`

let observer: MutationObserver | null = null
let style: HTMLStyleElement | null = null
let unsubscribe: (() => void) | null = null
let scheduled = 0

interface RowControls {
  icon: HTMLSpanElement
  end: HTMLElement
  switch_: Element | null
}

/** The card head's icon box and end cluster, located structurally inside the row. */
function rowControls(row: HTMLElement): RowControls | null {
  const head = row.firstElementChild
  if (!(head instanceof HTMLElement)) return null
  const icon = head.querySelector<HTMLSpanElement>(':scope > span[aria-hidden="true"]')
  if (icon === null) return null
  const switch_ = head.querySelector(':scope [role="switch"]')
  const end = switch_ !== null && switch_.parentElement instanceof HTMLElement
    ? switch_.parentElement
    : head.lastElementChild instanceof HTMLElement
      ? head.lastElementChild
      : null
  if (end === null) return null
  return { icon, end, switch_ }
}

/** The label/disabled pair a row's control shows for one package. */
function controlFor(name: string): { label: string; disabled: boolean; title: string; kind: 'update' | 'restart' } | null {
  const state = snapshot()
  const status = state.updates[name]
  const op: OpState | undefined = state.ops[name]
  if (status?.updateAvailable === true) {
    const error = op !== undefined && typeof op === 'object' ? op.error : undefined
    return { label: t('updateBtn'), disabled: op === 'updating', title: error !== undefined ? `${t('updateFailed')}: ${error}` : '', kind: 'update' }
  }
  if (op === 'updating') return { label: t('updating'), disabled: true, title: '', kind: 'update' }
  if (op === 'updated') return { label: t('restartShort'), disabled: false, title: '', kind: 'restart' }
  return null
}

function paintRow(row: HTMLElement): void {
  const name = row.getAttribute('data-plugin-package') ?? ''
  const control = name === '' ? null : controlFor(name)
  // Strip previous decorations first — cheap at plugin-page row counts, and
  // it keeps rows authoritative after React swaps nodes underneath us.
  row.querySelectorAll(`.${DOT_CLASS}, .${BTN_CLASS}`).forEach(element => { element.remove() })
  row.querySelectorAll<HTMLElement>('span[aria-hidden="true"]').forEach(element => {
    if (element.style.position === 'relative') element.style.position = ''
  })
  const controls = control === null ? null : rowControls(row)
  if (control === null || controls === null) return
  const hasUpdate = snapshot().updates[name]?.updateAvailable === true
  if (hasUpdate) {
    controls.icon.style.position = 'relative'
    const dot = document.createElement('span')
    dot.className = DOT_CLASS
    dot.dataset.dpiFor = name
    controls.icon.appendChild(dot)
  }
  const button = document.createElement('button')
  button.type = 'button'
  button.className = BTN_CLASS
  button.dataset.dpiFor = name
  button.textContent = control.label
  button.disabled = control.disabled
  if (control.title !== '') button.title = control.title
  button.addEventListener('click', () => {
    const kind = controlFor(name)?.kind
    if (kind === 'update') void updatePlugin(name)
    if (kind === 'restart') void restartHost()
  })
  if (controls.switch_ !== null) controls.end.insertBefore(button, controls.switch_)
  else controls.end.appendChild(button)
}

function paint(): void {
  document.querySelectorAll<HTMLElement>('li[data-plugin-package]').forEach(paintRow)
}

function schedule(): void {
  window.clearTimeout(scheduled)
  scheduled = window.setTimeout(paint, 150)
}

/** Mount the row layer; the disposer removes every trace on plugin unload. */
export function installRowLayer(translate: Translate): () => void {
  t = translate
  style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
  observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  unsubscribe = subscribe(schedule)
  paint()
  return () => {
    window.clearTimeout(scheduled)
    observer?.disconnect()
    observer = null
    unsubscribe?.()
    unsubscribe = null
    style?.remove()
    style = null
    document.querySelectorAll(`.${DOT_CLASS}, .${BTN_CLASS}`).forEach(element => { element.remove() })
    document.querySelectorAll<HTMLElement>('li[data-plugin-package] span[aria-hidden="true"]').forEach(element => {
      if (element.style.position === 'relative') element.style.position = ''
    })
  }
}
