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

type AuthConfig = { supabase_url: string; supabase_anon_key: string; google_enabled?: boolean; account_deletion?: boolean }
type AuthResponse = Partial<AuthSession> & { expires_in?: number; user?: AuthUser & { identities?: unknown[] }; identities?: unknown[] }

export const AUTH_SESSION_KEY = 'bindit-auth-session'
const SESSION_KEY = AUTH_SESSION_KEY
const LEGACY_SESSION_KEY = 'numi-auth-session'
// The account whose study data is currently kept in this browser's storage.
const DATA_OWNER_KEY = 'bindit-data-owner'
// Every key bindet (and its earlier names) has written to localStorage.
const LOCAL_DATA_PREFIXES = ['bindit-', 'bindit:', 'bindet-', 'numi-', 'cac-']
// Purely cosmetic preferences that are safe to keep across accounts. Anything
// that reflects account data (important items, task tabs/notices) is cleared.
// bindit:install-dismissed hides the "Install bindet" offer in the phone menu (lib/pwa.ts).
const COSMETIC_KEYS = new Set<string>(['bindit:theme', 'bindit:sidebar:collapsed', 'bindit:sidebar:layout:v2', 'bindit:focus-text-size', 'bindit:install-dismissed'])
// Device-level flags that aren't account data and must outlive a sign-out.
const DEVICE_KEYS = new Set<string>(['bindit-reset-requested'])
// A Google sign-in started here is pending until the browser comes back from Google.
// It is cleared on sign-out like any other bindit- key; it only has to last the round trip.
const OAUTH_FLOW_KEY = 'bindit-oauth-flow'
// Where public/theme-init.js puts a Google return's query (?code=, ?flow=, ?error=…)
// after taking it out of the address bar, before any other script or request runs.
const OAUTH_RETURN_KEY = 'bindit-auth-return'
export const ACCOUNT_DATA_CLEARED_EVENT = 'bindit:account-data-cleared'
// The IndexedDB database holding flashcards saved for offline study (lib/offlineCards.ts).
export const OFFLINE_DB_NAME = 'bindit-offline'

/* Deletes the offline flashcards. Started synchronously so it is queued even when the page reloads right after. */
function deleteOfflineStore() {
  try {
    indexedDB?.deleteDatabase(OFFLINE_DB_NAME)
  } catch {
    // IndexedDB can be unavailable (some private modes); then nothing was saved.
  }
}
const API_URL = import.meta.env.VITE_API_URL ?? ''
let configPromise: Promise<AuthConfig> | null = null

function appReturnUrl() {
  const configuredUrl = import.meta.env.VITE_PUBLIC_APP_URL?.trim()
  const baseUrl = configuredUrl || window.location.origin
  return `${baseUrl.replace(/\/$/, '')}/`
}

function config() {
  if (!configPromise) {
    const pending: Promise<AuthConfig> = fetch(`${API_URL}/api/auth/config`).then(async (response) => {
      if (!response.ok) throw new Error('Accounts are not configured yet.')
      return response.json() as Promise<AuthConfig>
    })
    configPromise = pending
    // Forget a failed fetch so the next call tries again instead of failing until reload.
    pending.catch(() => {
      if (configPromise === pending) configPromise = null
    })
  }
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
 * Removes everything bindet keeps in this browser for an account: the auth
 * session, notebook, avatar, study session, attempt history, student id and
 * the per-tab caches and the offline flashcards. In-memory caches listen for
 * ACCOUNT_DATA_CLEARED_EVENT.
 */
export function clearLocalAccountData() {
  try {
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key && !COSMETIC_KEYS.has(key) && !DEVICE_KEYS.has(key) && LOCAL_DATA_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key)
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
  deleteOfflineStore()
  window.dispatchEvent(new Event(ACCOUNT_DATA_CLEARED_EVENT))
}

/**
 * Ends the signed-in state without touching local-only study data: removes the
 * session, the tab's sessionStorage, the cached server responses (`bindit:` keys
 * other than cosmetic preferences), the offline flashcards and in-memory caches. The notebook, attempt
 * history, avatar, student id and data owner stay, so the same account gets them
 * back on its next sign-in; claimLocalData wipes them if a different account
 * signs in instead.
 */
export function clearSignedInState() {
  try {
    localStorage.removeItem(SESSION_KEY)
    localStorage.removeItem(LEGACY_SESSION_KEY)
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key && key.startsWith('bindit:') && !COSMETIC_KEYS.has(key)) keys.push(key)
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
  deleteOfflineStore()
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

const sessionListeners = new Set<() => void>()

export function saveAuthSession(session: AuthSession | null) {
  if (session) {
    claimLocalData(session.user.id)
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    localStorage.removeItem(LEGACY_SESSION_KEY)
  } else {
    localStorage.removeItem(SESSION_KEY)
    localStorage.removeItem(LEGACY_SESSION_KEY)
  }
  sessionListeners.forEach((listener) => listener())
}

/**
 * Calls back whenever the stored session changes: a refresh or sign-in in this
 * tab, or in another tab (storage event). Read the new one with loadAuthSession.
 */
export function subscribeToAuthSession(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea === localStorage && (event.key === null || event.key === SESSION_KEY)) listener()
  }
  sessionListeners.add(listener)
  window.addEventListener('storage', onStorage)
  return () => {
    sessionListeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** An error the Supabase auth server answered with (as opposed to a network failure). */
export class AuthRequestError extends Error {
  readonly status: number
  /** The auth server's error_code (e.g. invalid_credentials, otp_expired), when it sent one. */
  readonly code: string
  constructor(message: string, status: number, code = '') {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Sign-up was refused because the email already has an account. */
export const EMAIL_TAKEN = 'email_taken'

/**
 * Plain words for what the auth server (or the network) said. Known cases get fixed,
 * friendly text with a next step; anything else keeps the server's own message.
 */
export function friendlyAuthError(error: unknown, fallback: string): string {
  if (error instanceof TypeError) return 'We can’t reach bindet right now. Check your connection and try again.'
  if (!(error instanceof Error)) return fallback
  const code = error instanceof AuthRequestError ? error.code : ''
  const status = error instanceof AuthRequestError ? error.status : 0
  const text = `${code} ${error.message}`.toLowerCase()
  if (code === EMAIL_TAKEN || /user_already_exists|already registered|already been registered/.test(text)) {
    return 'That email already has a bindet account. Log in instead, or reset your password if you forgot it.'
  }
  if (/invalid_credentials|invalid login credentials/.test(text)) return 'That email and password don’t match. Check them and try again, or reset your password.'
  if (/otp_expired|token has expired|invalid otp|token is invalid|otp_invalid/.test(text)) return 'That code didn’t work. It may have expired: check the 6 digits or send a new code.'
  if (/weak_password|password should|password is too/.test(text)) return 'Use at least 8 characters for your password.'
  if (/email_address_invalid|validate email|invalid email|email address .* is invalid/.test(text)) return 'That email address doesn’t look right. Check it and try again.'
  if (status === 429 || /rate limit|too many|over_email_send_rate_limit|over_request_rate_limit/.test(text)) return 'Too many tries for now. Wait a minute, then try again.'
  if (/signup.* disabled|signups not allowed/.test(text)) return 'New accounts are paused right now. Try again later.'
  return error.message || fallback
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
    const code = [data.error_code, data.code, data.error].find((value) => typeof value === 'string' && /^[a-z_]+$/.test(value))
    throw new AuthRequestError((message as string | undefined) ?? fallback, response.status, (code as string | undefined) ?? '')
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
  /** The auth server rejected the refresh token; the session and cached account responses were cleared. */
  rejected?: boolean
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
        // The session is over, but this isn't an explicit sign-out: keep local-only
        // study data for when the same account signs back in.
        clearSignedInState()
        return { session: null, failed: false, rejected: true }
      }
      return { session: latest, failed: true }
    }
  }).finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

/** Like refreshSessionIfDue, but only returns the session. Reloads the page when the refresh is rejected. */
export async function refreshAuthSession(session: AuthSession, options: { reloadOnReject?: boolean } = {}): Promise<AuthSession | null> {
  if (!sessionNeedsRefresh(session)) return session
  const result = await refreshSessionIfDue(session)
  if (result.rejected && options.reloadOnReject !== false) reloadSignedOut()
  return result.session
}

export async function signUp(email: string, password: string) {
  const data = await authRequest('signup', { email, password }, appReturnUrl())
  // An email that is already registered gets the same answer as a new one (the auth server
  // hides it on purpose so nobody can check who has an account). The code screen offers
  // "Log in" and "Reset password" for that case instead.
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
  await readAuthResponse(response, 'Could not resend the confirmation email.')
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

// Set in localStorage when this browser asks for a reset link, so a recovery link
// opened here (in any tab, within RESET_REQUEST_TTL_MS) skips the extra confirmation
// that a link this browser didn't ask for gets. Not a `bindit:` key, and kept by
// clearLocalAccountData, because it is written while signed out and must survive
// until the link is opened.
const RESET_REQUESTED_KEY = 'bindit-reset-requested'
const RESET_REQUEST_TTL_MS = 60 * 60 * 1000

export async function requestPasswordReset(email: string) {
  await authRequest('recover', { email }, appReturnUrl())
  try {
    localStorage.setItem(RESET_REQUESTED_KEY, String(Date.now()))
  } catch {
    // Without storage the recovery link just asks for confirmation first.
  }
}

/** True (once) when this browser requested a password reset within the last hour. */
function takeResetRequested() {
  try {
    const requested = Number(localStorage.getItem(RESET_REQUESTED_KEY))
    localStorage.removeItem(RESET_REQUESTED_KEY)
    const age = Date.now() - requested
    return requested > 0 && age >= 0 && age <= RESET_REQUEST_TTL_MS
  } catch {
    return false
  }
}

const resetChecks = new WeakMap<object, boolean>()

/**
 * takeResetRequested, answered once per redirect: the flag is removed when read, so a
 * re-run effect (React StrictMode in development) must get the same answer as the first run.
 */
export function resetRequestedFor(redirect: AuthRedirect) {
  if (!resetChecks.has(redirect)) resetChecks.set(redirect, takeResetRequested())
  return resetChecks.get(redirect) === true
}

export type AuthRedirect =
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'tokens'; accessToken: string; refreshToken: string; expiresIn: number; type: string }
  // A Google sign-in coming back with its one-time code, and this browser's own verifier for it.
  | { kind: 'oauth'; code: string; codeVerifier: string }

let authRedirect: AuthRedirect | null = null

const LINK_EXPIRED_MESSAGE = 'That link is invalid or has expired. Request a new one and try again.'
const REDIRECT_ERROR_MESSAGES: Record<string, string> = {
  otp_expired: LINK_EXPIRED_MESSAGE,
  flow_state_expired: LINK_EXPIRED_MESSAGE,
  flow_state_not_found: LINK_EXPIRED_MESSAGE,
  bad_jwt: LINK_EXPIRED_MESSAGE,
  bad_code_verifier: LINK_EXPIRED_MESSAGE,
  invalid_request: LINK_EXPIRED_MESSAGE,
  unauthorized_client: LINK_EXPIRED_MESSAGE,
  access_denied: 'That link was not accepted. Request a new one and try again.',
  otp_disabled: 'Email links are turned off right now. Log in with your password instead.',
  email_address_not_authorized: 'We can’t send email to that address. Try another one.',
  over_email_send_rate_limit: 'Too many emails were sent. Wait a few minutes, then request a new link.',
  over_request_rate_limit: 'Too many attempts. Wait a few minutes and try again.',
  user_banned: 'This account can’t sign in right now.',
  signup_disabled: 'New accounts can’t be created right now.',
  server_error: 'Something went wrong on our side. Request a new link and try again.',
  temporarily_unavailable: 'Accounts are briefly unavailable. Try again in a few minutes.',
  unexpected_failure: 'Something went wrong on our side. Request a new link and try again.',
}

/** A fixed, friendly message for a known error code from an email link; never the URL's own text. */
function redirectErrorMessage(errorCode: string | null, errorName: string | null) {
  return (errorCode && REDIRECT_ERROR_MESSAGES[errorCode])
    || (errorName && REDIRECT_ERROR_MESSAGES[errorName])
    || 'That link did not work. Request a new one and try again.'
}

/**
 * Reads what the auth server put in the URL after an email link (fragment
 * tokens: sign-up confirmation, password recovery) or a Google sign-in (query
 * `code`, or an OAuth error), and removes it from the address bar. Read once
 * per page load; nothing in it is trusted until checked with the auth server.
 */
export function takeAuthRedirect(): AuthRedirect {
  if (authRedirect) return authRedirect
  const oauth = takeOAuthRedirect()
  pruneExpiredOAuthFlows()
  if (oauth) {
    authRedirect = oauth
    return authRedirect
  }
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const accessToken = params.get('access_token')
  const refreshToken = params.get('refresh_token')
  const errorCode = params.get('error_code')
  const errorName = params.get('error')
  const hasError = Boolean(errorCode || errorName || params.get('error_description'))
  if (accessToken || refreshToken || hasError) {
    window.history.replaceState(window.history.state, document.title, `${window.location.pathname}${window.location.search}`)
  }
  if (hasError) {
    // Anyone can craft this URL, so its free-text error_description is never shown.
    authRedirect = { kind: 'error', message: redirectErrorMessage(errorCode, errorName) }
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

// ---------------------------------------------------------------------------
// Continue with Google (OAuth 2.0 authorization code flow with PKCE, RFC 7636)
//
// Only the browser that started the sign-in holds the code verifier, so a code
// someone else obtained (or tricked this browser into opening) can't be turned
// into a session here: the auth server refuses a verifier that doesn't match
// the challenge the code was issued for. That is what stops login CSRF.
// ---------------------------------------------------------------------------

/** How long a started Google sign-in may take before its verifier is refused. */
const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000
const OAUTH_NOT_STARTED_HERE = 'That sign-in link didn’t start in this browser. Try again.'
const OAUTH_EXPIRED = 'That Google sign-in took too long. Try again.'
const OAUTH_FAILED = 'Google sign-in didn’t finish. Try again.'
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: 'Google sign-in was cancelled.',
  user_cancelled: 'Google sign-in was cancelled.',
  provider_disabled: 'Google sign-in isn’t available right now. Use your email instead.',
  validation_failed: 'Google sign-in isn’t available right now. Use your email instead.',
  bad_oauth_state: OAUTH_EXPIRED,
  bad_oauth_callback: OAUTH_FAILED,
  flow_state_expired: OAUTH_EXPIRED,
  flow_state_not_found: OAUTH_EXPIRED,
  bad_code_verifier: OAUTH_NOT_STARTED_HERE,
  provider_email_needs_verification: 'Verify your email with Google first, then try again.',
  email_address_invalid: 'Google didn’t share a usable email address. Use your email instead.',
  signup_disabled: 'New accounts can’t be created right now.',
  user_banned: 'This account can’t sign in right now.',
  over_request_rate_limit: 'Too many attempts. Wait a few minutes and try again.',
  temporarily_unavailable: 'Accounts are briefly unavailable. Try again in a few minutes.',
  server_error: OAUTH_FAILED,
  unexpected_failure: OAUTH_FAILED,
}

type OAuthFlow = { id: string; verifier: string; createdAt: number }

function base64Url(bytes: Uint8Array) {
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomBase64Url(byteLength: number) {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

function readOAuthFlow(storage: Storage): OAuthFlow | null {
  try {
    const raw = storage.getItem(OAUTH_FLOW_KEY)
    if (!raw) return null
    const flow = JSON.parse(raw) as Partial<OAuthFlow>
    if (typeof flow.id !== 'string' || typeof flow.verifier !== 'string' || typeof flow.createdAt !== 'number') return null
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(flow.verifier)) return null
    return flow as OAuthFlow
  } catch {
    return null
  }
}

function forgetOAuthFlow() {
  for (const storage of [sessionStorage, localStorage]) {
    try {
      storage.removeItem(OAUTH_FLOW_KEY)
    } catch {
      // Storage unavailable: nothing was kept there.
    }
  }
}

/**
 * The Google sign-in this browser started, if any (expired or not). The tab's own copy
 * wins; the localStorage copy covers browsers that drop sessionStorage across the
 * round trip to Google. Nothing is removed here.
 */
function readStoredOAuthFlow(): OAuthFlow | null {
  let flow: OAuthFlow | null = null
  for (const storage of [sessionStorage, localStorage]) {
    try {
      flow ??= readOAuthFlow(storage)
    } catch {
      // Storage unavailable.
    }
  }
  return flow
}

function oauthFlowExpired(flow: OAuthFlow) {
  const age = Date.now() - flow.createdAt
  return age < 0 || age > OAUTH_FLOW_TTL_MS
}

/* Removes a stored sign-in that can no longer finish, so a stale verifier never lingers. */
function pruneExpiredOAuthFlows() {
  for (const storage of [sessionStorage, localStorage]) {
    try {
      const raw = storage.getItem(OAUTH_FLOW_KEY)
      if (!raw) continue
      const flow = readOAuthFlow(storage)
      if (!flow || oauthFlowExpired(flow)) storage.removeItem(OAUTH_FLOW_KEY)
    } catch {
      // Storage unavailable.
    }
  }
}

const OAUTH_QUERY_KEYS = ['code', 'flow', 'error', 'error_code', 'error_description', 'state']
const OAUTH_RETURN_MAX_AGE_MS = 2 * 60 * 1000

/**
 * The query a Google sign-in came back with. public/theme-init.js normally moved it
 * from the address bar into sessionStorage before anything loaded (so the code never
 * reaches a Referer header); without storage it is still in the URL, and is taken
 * out of the address bar and history here.
 */
function takeOAuthReturnParams(): URLSearchParams {
  const params = new URLSearchParams()
  try {
    const raw = sessionStorage.getItem(OAUTH_RETURN_KEY)
    if (raw) {
      sessionStorage.removeItem(OAUTH_RETURN_KEY)
      const saved = JSON.parse(raw) as { at?: unknown; params?: unknown }
      const age = typeof saved.at === 'number' ? Date.now() - saved.at : Infinity
      if (age >= 0 && age <= OAUTH_RETURN_MAX_AGE_MS && saved.params && typeof saved.params === 'object') {
        for (const [key, value] of Object.entries(saved.params as Record<string, unknown>)) {
          if (OAUTH_QUERY_KEYS.includes(key) && typeof value === 'string') params.set(key, value)
        }
      }
    }
  } catch {
    // Storage unavailable or unreadable: fall back to the address bar.
  }
  const query = new URLSearchParams(window.location.search)
  if (OAUTH_QUERY_KEYS.some((key) => query.has(key))) {
    OAUTH_QUERY_KEYS.forEach((key) => {
      const value = query.get(key)
      if (value !== null && !params.has(key)) params.set(key, value)
      query.delete(key)
    })
    const search = query.toString()
    window.history.replaceState(window.history.state, document.title, `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`)
  }
  return params
}

/**
 * Handles a return from Google (query `code` or OAuth error, plus the `flow` id this
 * browser put in the return address); null when the URL isn't one. A code is only
 * exchanged when its flow id matches the sign-in this browser started, and the stored
 * verifier is only forgotten then: a crafted `?code=` or `?error=` can't cancel a
 * sign-in that is still on its way back.
 */
function takeOAuthRedirect(): AuthRedirect | null {
  const query = takeOAuthReturnParams()
  const code = query.get('code')
  const flowId = query.get('flow')
  const errorName = query.get('error')
  const errorCode = query.get('error_code')
  // A bare ?error= with nothing else is someone else's URL; ours always comes with a flow id, a code or details.
  const isOAuthError = Boolean(errorName && (errorCode || query.has('error_description') || flowId))
  if (!code && !isOAuthError && !flowId) return null
  const flow = readStoredOAuthFlow()
  // Never exchange a code without this browser's own verifier for this very sign-in.
  if (!flow || !flowId || flowId !== flow.id) return { kind: 'error', message: OAUTH_NOT_STARTED_HERE }
  forgetOAuthFlow()
  if (oauthFlowExpired(flow)) return { kind: 'error', message: OAUTH_EXPIRED }
  if (isOAuthError) {
    // Anyone can craft this URL, so its free-text error_description is never shown.
    const message = (errorCode && OAUTH_ERROR_MESSAGES[errorCode]) || (errorName && OAUTH_ERROR_MESSAGES[errorName]) || OAUTH_FAILED
    return { kind: 'error', message }
  }
  if (!code || code.length > 512) return { kind: 'error', message: OAUTH_FAILED }
  return { kind: 'oauth', code, codeVerifier: flow.verifier }
}

/** True when the server can delete an account in the app (its service key is configured). */
export async function accountDeletionEnabled() {
  try {
    return (await config()).account_deletion === true
  } catch {
    return false
  }
}

/** True when the server has Google sign-in turned on (AUTH_GOOGLE_ENABLED). */
export async function googleSignInEnabled() {
  try {
    return (await config()).google_enabled === true
  } catch {
    return false
  }
}

/**
 * Starts "Continue with Google": saves a fresh PKCE verifier in this browser and
 * sends the page to the auth server, which hands over to Google and comes back
 * to appReturnUrl() with `?flow=<id>&code=`. Resolves only if navigation didn't happen.
 */
export async function startGoogleSignIn() {
  const settings = await config()
  if (settings.google_enabled !== true) throw new Error('Google sign-in isn’t available right now. Use your email instead.')
  if (!globalThis.crypto?.subtle) throw new Error('This browser can’t sign in with Google here. Use your email instead.')
  // 64 random bytes -> an 86-character verifier (RFC 7636 allows 43-128).
  const verifier = randomBase64Url(64)
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const flow: OAuthFlow = { id: randomBase64Url(16), verifier, createdAt: Date.now() }
  let saved = false
  for (const storage of [sessionStorage, localStorage]) {
    try {
      storage.setItem(OAUTH_FLOW_KEY, JSON.stringify(flow))
      saved = true
    } catch {
      // Try the other storage.
    }
  }
  if (!saved) throw new Error('Google sign-in needs site storage turned on. Use your email instead.')
  const authorizeUrl = new URL(`${settings.supabase_url}/auth/v1/authorize`)
  authorizeUrl.searchParams.set('provider', 'google')
  // Always our own address, never one taken from the URL: no open redirect. The flow id
  // ties the code that comes back to this sign-in (the Supabase redirect allowlist entry
  // for the app, `<origin>/**`, covers `/?flow=…`).
  authorizeUrl.searchParams.set('redirect_to', `${appReturnUrl()}?flow=${encodeURIComponent(flow.id)}`)
  authorizeUrl.searchParams.set('code_challenge', challenge)
  authorizeUrl.searchParams.set('code_challenge_method', 's256')
  window.location.assign(authorizeUrl.toString())
}

const oauthExchanges = new WeakMap<object, Promise<AuthSession>>()

/**
 * Trades the code from a Google sign-in for a session, using this browser's
 * verifier, then confirms the account with the auth server. The session is not
 * saved here; the caller decides (it may belong to a different account).
 */
export function exchangeOAuthCode(redirect: Extract<AuthRedirect, { kind: 'oauth' }>): Promise<AuthSession> {
  // A code works once; a second caller for the same redirect (a re-run effect) shares the first exchange.
  let pending = oauthExchanges.get(redirect)
  if (!pending) {
    pending = runOAuthExchange(redirect)
    oauthExchanges.set(redirect, pending)
  }
  return pending
}

async function runOAuthExchange(redirect: Extract<AuthRedirect, { kind: 'oauth' }>): Promise<AuthSession> {
  let data: AuthResponse
  try {
    data = await authRequest('token?grant_type=pkce', { auth_code: redirect.code, code_verifier: redirect.codeVerifier })
  } catch {
    // Fixed text only: the server's message is not shown. A used, unknown or
    // expired code and a verifier that doesn't match all end here.
    throw new Error(OAUTH_FAILED)
  }
  const session = asSession(data)
  if (!session) throw new Error(OAUTH_FAILED)
  try {
    const user = await fetchAuthUser(session.access_token)
    return { ...session, user }
  } catch {
    discardSession(session)
    throw new Error(OAUTH_FAILED)
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

/** Reloads the page without the URL fragment, so no in-memory state from a signed-out account survives. */
export function reloadSignedOut() {
  window.location.replace(`${window.location.pathname}${window.location.search}`)
}

/** Signs out and reloads, so nothing from the account stays in memory. */
export function signOutAndReload() {
  void signOut().finally(reloadSignedOut)
}

/*
 * A one-time message for the signed-out screens after an account action:
 * 'deleted' (the landing page says the account and data were deleted) or
 * 'reauth-delete' (the sign-in card asks for a fresh sign-in to finish deleting).
 * It lives in this tab's sessionStorage and is written after signOut() has cleared
 * storage, so it survives exactly one reload.
 */
export type AccountNotice = 'deleted' | 'reauth-delete'
const ACCOUNT_NOTICE_KEY = 'bindit-account-notice'

export function takeAccountNotice(): AccountNotice | null {
  try {
    const value = sessionStorage.getItem(ACCOUNT_NOTICE_KEY)
    sessionStorage.removeItem(ACCOUNT_NOTICE_KEY)
    return value === 'deleted' || value === 'reauth-delete' ? value : null
  } catch {
    return null
  }
}

/** Signs out (clearing this browser's account data), leaves a notice for the next screen, and reloads. */
export async function signOutWithNotice(notice: AccountNotice) {
  try {
    await signOut()
  } finally {
    try {
      sessionStorage.setItem(ACCOUNT_NOTICE_KEY, notice)
    } catch {
      // Without storage the next screen simply shows no notice.
    }
    reloadSignedOut()
  }
}
