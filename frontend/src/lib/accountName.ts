import type { AuthUser } from './auth'

function metadataText(user: AuthUser | null | undefined, key: string) {
  const value = user?.user_metadata?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The name to show for an account that hasn't saved a profile yet: the username
 * it chose, else the name its Google profile shares (full_name / name).
 */
export function accountDisplayName(user: AuthUser | null | undefined) {
  return (metadataText(user, 'username') || metadataText(user, 'full_name') || metadataText(user, 'name')).slice(0, 40)
}

/**
 * A username to suggest (the person can change it) that fits the profile rule
 * ^[a-z0-9_]{3,24}$: the chosen username, else one made from the Google name or
 * the email's local part.
 */
export function suggestedUsername(user: AuthUser | null | undefined) {
  const chosen = metadataText(user, 'username')
  if (/^[a-z0-9_]{3,24}$/.test(chosen)) return chosen
  const source = chosen || metadataText(user, 'full_name') || metadataText(user, 'name') || (user?.email ?? '').split('@')[0]
  const slug = source
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
    .replace(/_+$/, '')
  if (slug.length >= 3) return slug
  return slug ? `${slug}_studies`.slice(0, 24) : ''
}
