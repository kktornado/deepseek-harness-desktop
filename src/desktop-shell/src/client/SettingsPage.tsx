/**
 * "桌面壳" settings page. Reads settings + state, posts patches via
 * `/desktop-shell/settings`, and triggers engine version switches through
 * `dsh:switchVersion`. The harness re-applies settings through
 * `/desktop-shell/apply`.
 *
 * Row styling mirrors the harness 通用设置 cells (figma 'Setting-Cell':
 * gap 8, pad 16/0, hairline separator; controls use the alias tokens).
 */

import { useEffect, useState } from 'react'
import {
  fetchShellSettings,
  patchShellSettings,
  requestShellApply,
} from './stores'
import type { ShellSettings } from './stores'

const SETTINGS_PATH = '/desktop-shell/settings'
const APPLY_PATH = '/desktop-shell/apply'
const SETTINGS_REFRESH_MS = 6000

const FIELDS: Array<{ key: keyof ShellSettings; label: string; type: 'number' | 'text' | 'boolean' | 'list'; hint?: string; dependsOnLan?: boolean }> = [
  { key: 'port', label: '端口', type: 'number' },
  { key: 'lan', label: '启用局域网访问', type: 'boolean' },
  { key: 'lanHost', label: '局域网监听地址', type: 'text', hint: '填写具体局域网 IP，例如 192.168.1.100（不能填 0.0.0.0）', dependsOnLan: true },
  { key: 'trustedHosts', label: '可信主机（换行分隔）', type: 'list', dependsOnLan: true },
]

interface DesktopState {
  engineVersion?: string
  latestVersion?: string
  updateAvailable?: boolean
  autoUpdate?: boolean
  installing?: string
  pendingUpdate?: string
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '16px 0',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
}

const rowTextStyle: React.CSSProperties = {
  flex: '1',
  minWidth: '0',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  paddingRight: '16px',
}

const rowTitleStyle: React.CSSProperties = {
  fontSize: '14px',
  fontWeight: 400,
  lineHeight: '22px',
  color: 'var(--dsw-alias-label-primary)',
}

const rowHintStyle: React.CSSProperties = {
  fontSize: '12px',
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
}

const controlStyle: React.CSSProperties = {
  flex: 'none',
}

const pillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  width: '220px',
  height: '36px',
  padding: '0 14px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: '18px',
  background: 'var(--dsw-alias-bg-module-platform)',
  font: 'inherit',
  fontSize: '14px',
  lineHeight: '22px',
  color: 'var(--dsw-alias-label-primary)',
  boxSizing: 'border-box',
}

const inputStyle: React.CSSProperties = {
  ...pillStyle,
  outline: 'none',
}

const textareaStyle: React.CSSProperties = {
  ...pillStyle,
  height: 'auto',
  minHeight: '72px',
  borderRadius: '12px',
  resize: 'vertical',
  width: '220px',
}

const buttonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: '36px',
  padding: '0 14px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: '18px',
  background: 'var(--dsw-alias-bg-module-platform)',
  font: 'inherit',
  fontSize: '14px',
  lineHeight: '22px',
  color: 'var(--dsw-alias-label-primary)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: 'var(--dsw-alias-accent-brand)',
  borderColor: 'var(--dsw-alias-accent-brand)',
  color: 'var(--dsw-alias-label-inverse, #ffffff)',
}

export function SettingsPage(_props: unknown): JSX.Element {
  const [settings, setSettings] = useState<ShellSettings | null>(null)
  const [state, setState] = useState<DesktopState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)
  const [needsRestart, setNeedsRestart] = useState(false)

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const [settingsValue, stateValue] = await Promise.all([
        fetchShellSettings(SETTINGS_PATH),
        (typeof window === 'undefined' ? null : window.desktop?.getState?.()) as Promise<DesktopState | null> | null,
      ])
      if (cancelled) return
      if (settingsValue) setSettings(settingsValue)
      if (stateValue) setState(stateValue as DesktopState)
    }
    void refresh()
    const handle = setInterval(refresh, SETTINGS_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [])

  async function patch(key: keyof ShellSettings, value: unknown): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const next = await patchShellSettings(SETTINGS_PATH, { [key]: value } as Partial<ShellSettings>)
      setSettings(next)
      // Only save to the plugin file here; do NOT request an immediate apply
      // (that would restart the harness and bounce the settings page back to
      // the conversation for every checkbox/keystroke). Changes that need a
      // restart (lan, port) surface an "apply" banner the user triggers once.
      if (key === 'lan' || key === 'port') {
        setNeedsRestart(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function applySettings(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await requestShellApply(APPLY_PATH, 'settings-apply')
      setNeedsRestart(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function installLatest(): Promise<void> {
    if (!window.desktop) return
    setSwitching('__latest__')
    setError(null)
    try {
      await window.desktop.updateEngine()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSwitching(null)
    }
  }

  const pageStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
  }
  const errorStyle: React.CSSProperties = {
    padding: '12px 16px',
    borderRadius: '8px',
    background: 'var(--dsw-alias-danger-bg, transparent)',
    color: 'var(--dsw-alias-danger-text, inherit)',
    fontSize: '13px',
    marginBottom: '8px',
  }
  const updateBannerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '12px 16px',
    borderRadius: '8px',
    background: 'var(--dsw-alias-warn-bg, rgba(229, 161, 60, 0.15))',
    border: '1px solid var(--dsw-alias-warn-border, rgba(229, 161, 60, 0.4))',
    color: 'var(--dsw-alias-warn-text, #e5a13c)',
    fontSize: '13px',
    marginBottom: '8px',
  }
  const spinnerStyle: React.CSSProperties = {
    fontSize: '13px',
    color: 'var(--dsw-alias-label-secondary)',
    padding: '16px 0',
  }

  const engineVersion = state?.engineVersion
  const installingVersion = state?.installing
  const updateAvailable = state?.updateAvailable === true
    || (state?.latestVersion !== undefined && state?.latestVersion !== engineVersion)
  const autoUpdate = settings?.autoUpdate === true

  return (
    <section style={pageStyle}>
      {error !== null && <div style={errorStyle}>{error}</div>}
      {settings === null && <div style={spinnerStyle}>加载中…</div>}

      {needsRestart && (
        <div style={updateBannerStyle}>
          <span>设置已更改，重启服务后生效</span>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={busy}
            onClick={() => void applySettings()}
          >
            {busy ? '重启中…' : '立即重启服务'}
          </button>
        </div>
      )}

      {state?.pendingUpdate !== undefined && (
        <div style={updateBannerStyle}>
          <span>引擎 v{state.pendingUpdate} 已下载，重启后生效</span>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={busy}
            onClick={() => { if (window.desktop) void window.desktop.applyPendingUpdate() }}
          >
            重启生效
          </button>
        </div>
      )}

      {updateAvailable && (
        <div style={updateBannerStyle}>
          <span>有新版本 {state?.latestVersion} 可用（当前 {engineVersion}）</span>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={switching !== null}
            onClick={() => void installLatest()}
          >
            {switching === '__latest__' ? '安装中…' : '立即安装'}
          </button>
        </div>
      )}

      {engineVersion !== undefined && (
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
          <div style={rowStyle}>
            <div style={rowTextStyle}>
              <div style={rowTitleStyle}>引擎版本</div>
            </div>
            <div style={rowTitleStyle}>{engineVersion}</div>
          </div>

          <div style={rowStyle}>
            <div style={rowTextStyle}>
              <div style={rowTitleStyle}>自动更新引擎</div>
            </div>
            <div style={controlStyle}>
              <input
                type="checkbox"
                style={{ width: '20px', height: '20px', cursor: 'pointer' }}
                checked={autoUpdate}
                disabled={busy}
                onChange={(event) => void patch('autoUpdate', event.currentTarget.checked)}
              />
            </div>
          </div>
        </div>
      )}

      {settings !== null && (
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
          {FIELDS.filter((field) => field.dependsOnLan !== true || settings.lan === true).map((field) => {
            const value = settings[field.key]
            return (
              <div key={field.key} style={rowStyle}>
                <div style={rowTextStyle}>
                  <div style={rowTitleStyle}>{field.label}</div>
                  {field.hint !== undefined && <div style={rowHintStyle}>{field.hint}</div>}
                </div>
                <div style={controlStyle}>
                  {field.type === 'number' && (
                    <input
                      type="number"
                      style={inputStyle}
                      min={1}
                      max={65535}
                      value={typeof value === 'number' ? value : ''}
                      disabled={busy}
                      onChange={(event) => {
                        const num = Number(event.currentTarget.value)
                        if (Number.isInteger(num) && num >= 1 && num <= 65535) void patch(field.key, num)
                      }}
                    />
                  )}
                  {field.type === 'text' && (
                    <input
                      type="text"
                      style={inputStyle}
                      value={typeof value === 'string' ? value : ''}
                      disabled={busy}
                      onChange={(event) => void patch(field.key, event.currentTarget.value)}
                    />
                  )}
                  {field.type === 'boolean' && (
                    <input
                      type="checkbox"
                      style={{ width: '20px', height: '20px', cursor: 'pointer' }}
                      checked={value === true}
                      disabled={busy}
                      onChange={(event) => void patch(field.key, event.currentTarget.checked)}
                    />
                  )}
                  {field.type === 'list' && (
                    <textarea
                      rows={3}
                      style={textareaStyle}
                      value={Array.isArray(value) ? value.join('\n') : ''}
                      disabled={busy}
                      onChange={(event) => {
                        const list = event.currentTarget.value
                          .split('\n')
                          .map((line) => line.trim())
                          .filter((line) => line.length > 0)
                        void patch(field.key, list)
                      }}
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

export default SettingsPage