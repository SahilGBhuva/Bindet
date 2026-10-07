import type { Flashcard, FlashcardLibrary, NoteFlashcardState } from './api'
import { ACCOUNT_DATA_CLEARED_EVENT, OFFLINE_DB_NAME, loadAuthSession } from './auth'

/*
 * Flashcards kept on this device for offline study.
 *
 * When the Study page loads a unit's saved flashcards online, a copy goes into
 * IndexedDB under the signed-in account's id and the course and unit. Offline,
 * the page reads it back. Only the cards and each note's flashcard state are
 * kept (no note text). The whole database is deleted on sign-out, when the
 * session ends, and when another account signs in (lib/auth.ts), and records of
 * any other account are dropped on start-up. The landing demo never reaches this
 * module: it goes through the sandboxed data source.
 */

const STORE = 'units'
const MAX_CARDS_PER_UNIT = 500
const MAX_CARDS = 2000
const MAX_BYTES = 2_000_000

type UnitRecord = {
  key: string
  userId: string
  course: string
  unit: string
  savedAt: number
  bytes: number
  cards: Flashcard[]
  notes: NoteFlashcardState[]
}

export type OfflineLibrary = FlashcardLibrary & { savedAt: number }

let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (opening) return opening
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable'))
      return
    }
    const request = indexedDB.open(OFFLINE_DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
    }
    request.onsuccess = () => {
      const db = request.result
      // A sign-out elsewhere deletes the database: let go of it so the delete isn't blocked.
      db.onversionchange = () => {
        db.close()
        if (opening === pending) opening = null
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('IndexedDB is blocked'))
  })
  opening = pending
  pending.catch(() => {
    if (opening === pending) opening = null
  })
  return pending
}

function closeConnection() {
  const pending = opening
  opening = null
  void pending?.then((db) => db.close(), () => undefined)
}

window.addEventListener(ACCOUNT_DATA_CLEARED_EVENT, closeConnection)

function done(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

function allRecords(db: IDBDatabase): Promise<UnitRecord[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    request.onsuccess = () => resolve(request.result as UnitRecord[])
    request.onerror = () => reject(request.error)
  })
}

function signedInUser(): string | null {
  return loadAuthSession()?.user.id ?? null
}

const normal = (name: string) => name.trim().toLowerCase()
const unitKey = (userId: string, course: string, unit: string) => JSON.stringify([userId, normal(course), normal(unit)])

/* Saves a unit's flashcards for offline use, then trims the oldest units to stay within the limits. */
export async function saveOfflineCards(scope: { course: string; unit: string }, library: FlashcardLibrary): Promise<void> {
  const userId = signedInUser()
  if (!userId || !scope.course || !scope.unit) return
  try {
    const cards = library.cards.slice(0, MAX_CARDS_PER_UNIT)
    const keepIds = new Set(cards.map((card) => card.note_id))
    const notes = library.notes
      .filter((note) => keepIds.has(note.note_id) || note.status !== 'ready')
      .map((note) => ({ ...note, error: null }))
    const record: Omit<UnitRecord, 'bytes'> = { key: unitKey(userId, scope.course, scope.unit), userId, course: scope.course, unit: scope.unit, savedAt: Date.now(), cards, notes }
    const bytes = JSON.stringify(record).length * 2
    if (bytes > MAX_BYTES) return
    const db = await open()
    // The account may have changed while the database opened.
    if (signedInUser() !== userId) return
    const write = db.transaction(STORE, 'readwrite')
    write.objectStore(STORE).put({ ...record, bytes })
    await done(write)

    const records = (await allRecords(db)).sort((a, b) => b.savedAt - a.savedAt)
    let totalCards = 0
    let totalBytes = 0
    const evict: string[] = []
    for (const item of records) {
      if (item.userId !== userId) { evict.push(item.key); continue }
      totalCards += item.cards.length
      totalBytes += item.bytes
      if (totalCards > MAX_CARDS || totalBytes > MAX_BYTES) evict.push(item.key)
    }
    if (!evict.length) return
    const trim = db.transaction(STORE, 'readwrite')
    evict.forEach((key) => trim.objectStore(STORE).delete(key))
    await done(trim)
  } catch {
    // Offline copies are a convenience: storage full or unavailable just means none is kept.
  }
}

/* The flashcards saved for a unit on this device by the signed-in account, if any. */
export async function loadOfflineCards(scope: { course: string; unit: string }): Promise<OfflineLibrary | null> {
  const userId = signedInUser()
  if (!userId) return null
  try {
    const db = await open()
    const record = await new Promise<UnitRecord | undefined>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(unitKey(userId, scope.course, scope.unit))
      request.onsuccess = () => resolve(request.result as UnitRecord | undefined)
      request.onerror = () => reject(request.error)
    })
    if (!record || record.userId !== userId) return null
    return { cards: record.cards, notes: record.notes, savedAt: record.savedAt }
  } catch {
    return null
  }
}

/* On start-up: signed out, nothing may stay; signed in, only this account's units stay. */
export function pruneOfflineCards() {
  if (typeof indexedDB === 'undefined') return
  const userId = signedInUser()
  if (!userId) {
    closeConnection()
    try {
      indexedDB.deleteDatabase(OFFLINE_DB_NAME)
    } catch {
      // Unavailable: nothing was saved.
    }
    return
  }
  void (async () => {
    try {
      const db = await open()
      const others = (await allRecords(db)).filter((item) => item.userId !== userId)
      if (!others.length) return
      const trim = db.transaction(STORE, 'readwrite')
      others.forEach((item) => trim.objectStore(STORE).delete(item.key))
      await done(trim)
    } catch {
      // Nothing to prune.
    }
  })()
}
