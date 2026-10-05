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

export const AUTH_SESSION_KEY = 'bindit-auth-session'
const SESSION_KEY = AUTH_SESSION_KEY
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

/** An error the Supabase auth server answered with (as opposed to a network failure). */
export class AuthRequestError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function readAuthResponse(response: Response, fallback: string): Promise<Record<string, unknown>> {
  const text = await response.text()
  let data: Record<string, unknown> = {}
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    data = {}
  }
  if (!response.ok) {
    const message = [data.msg, data.error_description, data.message].find((value) => typeof value === 'string')
    throw new AuthRequestError((message as string | undefined) ?? fallback, response.status)
  }
  return data
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
  return readAuthResponse(response, 'Account request failed.') as Promise<AuthResponse>
}

/** Asks the auth server who an access token belongs to. Throws if the token is not valid. */
async function fetchAuthUser(accessToken: string): Promise<AuthUser> {
  const settings = await config()
  const response = await fetch(`${settings.supabase_url}/auth/v1/user`, {
    headers: { apikey: settings.supabase_anon_key, Authorization: `Bearer ${accessToken}` },
  })
  const user = await readAuthResponse(response, 'That sign-in link is not valid.') as AuthUser
  if (!user.id) throw new AuthRequestError('That sign-in link is not valid.', response.status)
  return user
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

const REFRESH_MARGIN_SECS = 60
const REFRESH_LOCK = 'bindit-auth-refresh'

/** True when the access token expires within the next minute (or its expiry is unknown). */
export function sessionNeedsRefresh(session: AuthSession) {
  return !session.expires_at || session.expires_at <= Date.now() / 1000 + REFRESH_MARGIN_SECS
}

/** Milliseconds until the session should be refreshed (just after it enters the refresh window). */
export function msUntilRefresh(session: AuthSession) {
  if (!session.expires_at) return 0
  return Math.max(0, (session.expires_at - REFRESH_MARGIN_SECS) * 1000 - Date.now() + 1000)
}

export type RefreshResult = {
  session: AuthSession | null
  /** The refresh could not reach the auth server (or it errored); the session was kept. */
  failed: boolean
}

let refreshInFlight: Promise<RefreshResult> | null = null

// Only one tab refreshes at a time: refresh tokens rotate, so two tabs using the
// same one would sign each other out.
function withRefreshLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks?.request) return task()
  return locks.request(REFRESH_LOCK, task) as Promise<T>
}

/**
 * Refreshes the stored session if it is due. Signs out only when the auth
 * server rejects the refresh token (HTTP 400/401); network and server errors
 * keep the current session so a later attempt can succeed.
 */
export function refreshSessionIfDue(session: AuthSession): Promise<RefreshResult> {
  refreshInFlight ??= withRefreshLock(async (): Promise<RefreshResult> => {
    // Re-read storage after taking the lock: another tab may have refreshed or signed out.
    const latest = loadAuthSession()
    if (!latest) return { session: null, failed: false }
    if (latest.user.id !== session.user.id || latest.refresh_token !== session.refresh_token) return { session: latest, failed: false }
    if (!sessionNeedsRefresh(latest)) return { session: latest, failed: false }
    try {
      const refreshed = asSession(await authRequest('token?grant_type=refresh_token', { refresh_token: latest.refresh_token }))
      if (!refreshed) return { session: latest, failed: true }
      saveAuthSession(refreshed)
      return { session: refreshed, failed: false }
    } catch (error) {
      if (error instanceof AuthRequestError && (error.status === 400 || error.status === 401)) {
        saveAuthSession(null)
        return { session: null, failed: false }
      }
      return { session: latest, failed: true }
    }
  }).finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

export async function refreshAuthSession(session: AuthSession): Promise<AuthSession | null> {
  if (!sessionNeedsRefresh(session)) return session
  return (await refreshSessionIfDue(session)).session
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

export type AuthRedirect =
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'tokens'; accessToken: string; refreshToken: string; expiresIn: number; type: string }

let authRedirect: AuthRedirect | null = null

/**
 * Reads what the auth server put in the URL fragment after an email link
 * (sign-up confirmation, password recovery) and removes it from the address
 * bar. Read once per page load; the tokens are not trusted until verified.
 */
export function takeAuthRedirect(): AuthRedirect {
  if (authRedirect) return authRedirect
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const accessToken = params.get('access_token')
  const refreshToken = params.get('refresh_token')
  const errorCode = params.get('error') ?? params.get('error_code')
  const errorDescription = params.get('error_description')
  if (accessToken || refreshToken || errorCode || errorDescription) {
    window.history.replaceState(window.history.state, document.title, `${window.location.pathname}${window.location.search}`)
  }
  if (errorCode || errorDescription) {
    const message = (errorDescription || 'That link did not work.').replace(/\s+/g, ' ').trim().slice(0, 240)
    authRedirect = { kind: 'error', message: /expired|invalid/i.test(message) ? `${message}. Request a new link and try again.` : message }
  } else if (accessToken && refreshToken) {
    const expiresIn = Number(params.get('expires_in'))
    authRedirect = { kind: 'tokens', accessToken, refreshToken, expiresIn, type: params.get('type') ?? '' }
  } else {
    authRedirect = { kind: 'none' }
  }
  return authRedirect
}

/**
 * Checks fragment tokens with the auth server before anything uses them, so a
 * forged or expired link can't create a session. The result is not saved;
 * the caller confirms with the person first.
 */
export async function verifyRedirectTokens(redirect: Extract<AuthRedirect, { kind: 'tokens' }>): Promise<AuthSession> {
  const user = await fetchAuthUser(redirect.accessToken)
  return {
    access_token: redirect.accessToken,
    refresh_token: redirect.refreshToken,
    expires_at: Number.isFinite(redirect.expiresIn) && redirect.expiresIn > 0 ? Math.floor(Date.now() / 1000) + redirect.expiresIn : undefined,
    user,
  }
}

/** Revokes a session that was never stored (for example a declined sign-in link). */
export function discardSession(session: AuthSession) {
  void config()
    .then((settings) => fetch(`${settings.supabase_url}/auth/v1/logout?scope=local`, {
      method: 'POST',
      headers: { apikey: settings.supabase_anon_key, Authorization: `Bearer ${session.access_token}` },
    }))
    .catch(() => undefined)
}

/** Sets a new password for the signed-in (or recovering) account. */
export async function updatePassword(session: AuthSession, password: string): Promise<AuthSession> {
  if (password.length < 8) throw new Error('Use at least 8 characters for your password.')
  const settings = await config()
  const response = await fetch(`${settings.supabase_url}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      apikey: settings.supabase_anon_key,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password }),
  })
  const user = await readAuthResponse(response, 'Could not update your password.') as AuthUser
  revokeOtherSessions(session)
  return { ...session, user: { ...session.user, ...user } }
}

/**
 * After a password change, signs the account out everywhere else (scope=others
 * keeps this session). Best-effort: it never blocks or fails the change.
 */
function revokeOtherSessions(session: AuthSession) {
  void config()
    .then((settings) => fetch(`${settings.supabase_url}/auth/v1/logout?scope=others`, {
      method: 'POST',
      headers: { apikey: settings.supabase_anon_key, Authorization: `Bearer ${session.access_token}` },
      keepalive: true,
    }))
    .catch(() => undefined)
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
