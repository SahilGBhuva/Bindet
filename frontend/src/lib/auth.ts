export type AuthUser = {
  id: string
  email?: string
  user_metadata?: { username?: string; [key: string]: unknown }
}

export type AuthSession = {
  access_token: string
  refresh_token: string
  expires_at?: number
  user: AuthUser
}

type AuthConfig = { supabase_url: string; supabase_anon_key: string }
type AuthResponse = Partial<AuthSession> & { expires_in?: number; user?: AuthUser }

const SESSION_KEY = 'bindit-auth-session'
const LEGACY_SESSION_KEY = 'numi-auth-session'
// The account whose study data is currently kept in this browser's storage.
const DATA_OWNER_KEY = 'bindit-data-owner'
// Every key bindit (and its earlier names) has written to localStorage.
const LOCAL_DATA_PREFIXES = ['bindit-', 'bindet-', 'numi-', 'cac-']
// Purely cosmetic preferences that are safe to keep across accounts. None exist yet.
const COSMETIC_KEYS = new Set<string>()
export const ACCOUNT_DATA_CLEARED_EVENT = 'bindit:account-data-cleared'
const API_URL = import.meta.env.VITE_API_URL ?? ''
let configPromise: Promise<AuthConfig> | null = null

function appReturnUrl() {
  const configuredUrl = import.meta.env.VITE_PUBLIC_APP_URL?.trim()
  const baseUrl = configuredUrl || window.location.origin
  return `${baseUrl.replace(/\/$/, '')}/`
}

function config() {
  configPromise ??= fetch(`${API_URL}/api/auth/config`).then(async (response) => {
    if (!response.ok) throw new Error('Accounts are not configured yet.')
    return response.json() as Promise<AuthConfig>
  })
  return configPromise
}

export function loadAuthSession(): AuthSession | null {
  const raw = localStorage.getItem(SESSION_KEY) ?? localStorage.getItem(LEGACY_SESSION_KEY)
  if (!raw) return null
  try {
    const session = JSON.parse(raw) as AuthSession
    if (!session.access_token || !session.refresh_token || !session.user?.id) throw new Error('Invalid session')
    localStorage.setItem(SESSION_KEY, raw)
    localStorage.removeItem(LEGACY_SESSION_KEY)
    if (!localStorage.getItem(DATA_OWNER_KEY)) localStorage.setItem(DATA_OWNER_KEY, session.user.id)
    return session
  } catch {
    localStorage.removeItem(SESSION_KEY)
    localStorage.removeItem(LEGACY_SESSION_KEY)
    return null
  }
}

/**
 * Removes everything bindit keeps in this browser for an account: the auth
 * session, notebook, avatar, study session, attempt history, student id and
 * the per-tab caches. In-memory caches listen for ACCOUNT_DATA_CLEARED_EVENT.
 */
export function clearLocalAccountData() {
  try {
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key && !COSMETIC_KEYS.has(key) && LOCAL_DATA_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key)
    }
    keys.forEach((key) => localStorage.removeItem(key))
  } catch {
    // Storage can be unavailable (private mode); nothing to clear then.
  }
  try {
    sessionStorage.clear()
  } catch {
    // Same as above.
  }
  window.dispatchEvent(new Event(ACCOUNT_DATA_CLEARED_EVENT))
}

/**
 * Local study data belongs to whichever account signed in on this browser.
 * When a different account signs in, the previous account's data is wiped
 * before the new session is stored. Data with no recorded owner (written
 * before ownership was tracked) is adopted by the account that signs in.
 */
function claimLocalData(userId: string) {
  const owner = localStorage.getItem(DATA_OWNER_KEY)
  if (owner && owner !== userId) clearLocalAccountData()
  localStorage.setItem(DATA_OWNER_KEY, userId)
}

export function saveAuthSession(session: AuthSession | null) {
  if (session) {
    claimLocalData(session.user.id)
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    localStorage.removeItem(LEGACY_SESSION_KEY)
  } else {
    localStorage.removeItem(SESSION_KEY)
    localStorage.removeItem(LEGACY_SESSION_KEY)
  }
}

async function authRequest(path: string, body: Record<string, string>, redirectTo?: string): Promise<AuthResponse> {
  const settings = await config()
  const authUrl = new URL(`${settings.supabase_url}/auth/v1/${path}`)
  if (redirectTo) authUrl.searchParams.set('redirect_to', redirectTo)
  const response = await fetch(authUrl, {
    method: 'POST',
    headers: { apikey: settings.supabase_anon_key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!response.ok) {
    const message = [data.msg, data.error_description, data.message].find((value) => typeof value === 'string')
    throw new Error((message as string | undefined) ?? 'Account request failed.')
  }
  return data as AuthResponse
}

function asSession(data: AuthResponse): AuthSession | null {
  if (!data.access_token || !data.refresh_token || !data.user?.id) return null
  const expiresAt = data.expires_at ?? (data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : undefined)
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
    user: data.user,
  }
}

export async function refreshAuthSession(session: AuthSession): Promise<AuthSession | null> {
  if (session.expires_at && session.expires_at > Date.now() / 1000 + 60) return session
  try {
    const refreshed = asSession(await authRequest('token?grant_type=refresh_token', { refresh_token: session.refresh_token }))
    saveAuthSession(refreshed)
    return refreshed
  } catch {
    saveAuthSession(null)
    return null
  }
}

export async function signUp(email: string, password: string) {
  const data = await authRequest('signup', { email, password }, appReturnUrl())
  const session = asSession(data)
  saveAuthSession(session)
  return { session, needsConfirmation: !session }
}

export async function resendSignupConfirmation(email: string) {
  const settings = await config()
  const response = await fetch(`${settings.supabase_url}/auth/v1/resend`, {
    method: 'POST',
    headers: { apikey: settings.supabase_anon_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'signup', email, options: { emailRedirectTo: appReturnUrl() } }),
  })
  const text = await response.text()
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!response.ok) {
    const message = [data.msg, data.error_description, data.message].find((value) => typeof value === 'string')
    throw new Error((message as string | undefined) ?? 'Could not resend the confirmation email.')
  }
}

export async function verifySignupCode(email: string, token: string) {
  const session = asSession(await authRequest('verify', { type: 'signup', email, token }))
  if (!session) throw new Error('That code did not work. Try again or resend.')
  saveAuthSession(session)
  return session
}

export async function signIn(email: string, password: string) {
  const session = asSession(await authRequest('token?grant_type=password', { email, password }))
  if (!session) throw new Error('Could not create a login session.')
  saveAuthSession(session)
  return session
}

export async function requestPasswordReset(email: string) {
  await authRequest('recover', { email }, appReturnUrl())
}

export function consumeAuthRedirectSession(): AuthSession | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const accessToken = params.get('access_token')
  const refreshToken = params.get('refresh_token')
  if (!accessToken || !refreshToken) return null

  const expiresIn = Number(params.get('expires_in'))
  const tokenPayload = accessToken.split('.')[1]
  let user: AuthUser | null = null
  try {
    const normalized = tokenPayload.replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))) as {
      sub?: string
      email?: string
      user_metadata?: AuthUser['user_metadata']
    }
    if (payload.sub) user = { id: payload.sub, email: payload.email, user_metadata: payload.user_metadata }
  } catch {
    user = null
  }
  if (!user) return null

  const session: AuthSession = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Number.isFinite(expiresIn) ? Math.floor(Date.now() / 1000) + expiresIn : undefined,
    user,
  }
  saveAuthSession(session)
  window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`)
  return session
}

export async function updateUsername(session: AuthSession, username: string): Promise<AuthSession> {
  const settings = await config()
  const response = await fetch(`${settings.supabase_url}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      apikey: settings.supabase_anon_key,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: { username } }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.msg ?? data.error_description ?? data.message ?? 'Could not update your username.')
  const nextSession: AuthSession = { ...session, user: { ...session.user, ...data } }
  saveAuthSession(nextSession)
  return nextSession
}

/**
 * Signs this device out: revokes only this session on the server
 * (scope=local, so other devices stay signed in) and removes every piece of
 * account data from this browser. Callers should reload the page afterwards
 * so no in-memory state from the account survives.
 */
export async function signOut() {
  const session = loadAuthSession()
  clearLocalAccountData()
  if (!session) return
  try {
    const settings = await config()
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 3000)
    await fetch(`${settings.supabase_url}/auth/v1/logout?scope=local`, {
      method: 'POST',
      headers: { apikey: settings.supabase_anon_key, Authorization: `Bearer ${session.access_token}` },
      keepalive: true,
      signal: controller.signal,
    }).finally(() => window.clearTimeout(timer))
  } catch {
    // The local sign-out already happened; the server session expires on its own.
  }
}

/** Signs out and reloads, so nothing from the account stays in memory. */
export function signOutAndReload() {
  void signOut().finally(() => window.location.replace(`${window.location.pathname}${window.location.search}`))
}
