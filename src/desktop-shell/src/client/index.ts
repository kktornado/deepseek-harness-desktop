/**
 * Desktop shell client plugin — runs inside the harness web SPA.
 *
 * Registers a single UI surface into the harness slot system:
 *   - `settings.section` (list): a "桌面壳" settings page.
 *
 * Components are pure functions of their owner props + framework hooks; live
 * data is fetched with plain `useEffect` polling — local state is the
 * appropriate channel because each component owns its own data window.
 */

import { createElement } from 'react'
import { SettingsPage } from './SettingsPage'

export const name = '@dsh-desktop/shell'

/** Cordis services the plugin body needs at activation time. */
export const inject = ['slots']

export function apply(ctx: any): void {
  // The slot is declared by the harness's ui-settings base, whose plugin may
  // load after this one. `inject` waits on the declaration (and reruns after a
  // redeclaration), while a bare register into an undeclared slot fails the
  // plugin load — the engine's own settings plugins use this same pattern.
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'desktop-shell',
      order: -100,
      label: '桌面壳',
    },
    (props: any) => createElement(SettingsPage, props),
  ))
}

export default { name, inject, apply }