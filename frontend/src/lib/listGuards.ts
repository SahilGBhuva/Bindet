/*
 * Guards for list responses from Supabase REST. A failing request can still come
 * back as JSON (an error object such as { code, message }), and a cached value can
 * be stale or malformed, so nothing that is about to be iterated is trusted blindly.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The array inside `value`, keeping only items that pass `isItem`, or null when
 * `value` is not an array at all (so the caller can treat it as an error).
 */
export function asList<T>(value: unknown, isItem: (item: unknown) => item is T): T[] | null {
  if (!Array.isArray(value)) return null
  return value.filter(isItem)
}

/** Like asList, but a missing or malformed list becomes an empty one. */
export function listOrEmpty<T>(value: unknown, isItem: (item: unknown) => item is T): T[] {
  return asList(value, isItem) ?? []
}

/**
 * Reads a JSON list from a fetch response. Throws `message` when the request
 * failed, the body is not JSON, or the body is not an array.
 */
export async function readList<T>(response: Response, isItem: (item: unknown) => item is T, message: string): Promise<T[]> {
  if (!response.ok) throw new Error(message)
  const body: unknown = await response.json().catch(() => null)
  const list = asList(body, isItem)
  if (!list) throw new Error(message)
  return list
}
