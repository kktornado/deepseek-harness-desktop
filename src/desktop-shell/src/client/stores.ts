/**
 * Shared shell data layer. Each component reads through plain `useEffect`
 * polling because there is no harness framework hook for the desktop-shell
 * plugin's HTTP endpoints; the data is component-local and short-lived, so
 * the slot-system rule "only the component knows it → local state" applies.
 */

export interface ShellSettings {
  channel?: string
  port?: number
  autoUpdate?: boolean
  shortcut?: string
  lan?: boolean
  lanHost?: string
  trustedHosts?: string[]
  [key: string]: unknown
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${response.status}`)
  return (await response.json()) as T
}

export async function fetchShellSettings(path: string): Promise<ShellSettings | null> {
  try {
    return await fetchJson<ShellSettings>(path)
  } catch {
    return null
  }
}

export async function patchShellSettings(path: string, patch: Partial<ShellSettings>): Promise<ShellSettings> {
  return await fetchJson<ShellSettings>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export async function requestShellApply(path: string, reason: string): Promise<void> {
  await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  })
}