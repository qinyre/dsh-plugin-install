/** dsh-plugin-install client entry: the update layer on the Plugins page.
 *
 * Since dsh 0.2.0 the Plugins page itself owns install, removal, and mount
 * management; this plugin no longer contributes a tab of its own. What it
 * still adds is the one thing the page lacks — update awareness:
 * - a green dot on a card's icon and an Update control beside its switch
 *   (DOM layer — the page declares no per-row slot);
 * - an update tag and Update/Restart control on a bundle's detail page
 *   (the page's `plugins.detail.badge` / `plugins.detail.actions` slots);
 * - the update-count pill on the 插件 nav row.
 * All surfaces read one shared store fed by the installer's routes
 * (/dsh-plugin-install/*), so they always agree. */

import { UpdateAction, UpdateBadge } from './detailSlots.tsx'
import { installNavBadge, setNavBadgeCount } from './navBadge.ts'
import { installRowLayer } from './rowLayer.ts'
import { refresh, subscribe, updateCount } from './store.ts'
import { zh, en } from './locales.ts'

/** Locale dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginInstall'

/** The `t` function bound by the locale service. */
export interface Translate {
  (key: string): string
}

/** Minimal structural subset of the slots service. */
interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: unknown): unknown
}

/** Minimal structural subset of the locale service. */
interface LocaleService {
  register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(namespace: string): Translate
}

/** The client cordis context this plugin relies on (structural). */
interface InstallClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: LocaleService
  slots: SlotsService
}

export const name = 'dsh-plugin-install'
export const inject = ['slots', 'locale']

export function apply(ctx: InstallClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-install: dictionaries')

  const t = ctx.locale.bind(NS)

  // One store cadence: fill at load, then every 10 minutes. The server TTL
  // (30 min) bounds the real network traffic underneath. Store changes drive
  // the row painter; this effect additionally mirrors the count into the
  // nav badge.
  ctx.effect(() => installRowLayer(t), 'dsh-plugin-install: row layer')
  ctx.effect(() => installNavBadge(), 'dsh-plugin-install: nav badge')
  ctx.effect(() => subscribe(() => { setNavBadgeCount(updateCount()) }), 'dsh-plugin-install: badge mirror')
  ctx.effect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 10 * 60_000)
    return () => clearInterval(timer)
  }, 'dsh-plugin-install: refresh cadence')

  // Detail-page contributions on the official Plugins page. The page renders
  // the entries with the open page's subject (and the locale seat for the
  // declared namespace), so the components register as-is. On hosts without
  // these slots (0.1.x) the entries simply never render.
  ctx.slots.inject('plugins.detail.badge', () => {
    ctx.slots.register({
      name: 'plugins.detail.badge',
      id: 'update-badge',
      order: 20,
      label: () => t('updateAvailable'),
      locale: NS,
    }, UpdateBadge)
  })
  ctx.slots.inject('plugins.detail.actions', () => {
    ctx.slots.register({
      name: 'plugins.detail.actions',
      id: 'update-action',
      order: 20,
      label: () => t('updateBtn'),
      locale: NS,
    }, UpdateAction)
  })
}
