import { describe, expect, it } from 'vitest'
import { asList, isRecord, listOrEmpty, readList } from './listGuards'

type Row = { id: number }
const isRow = (value: unknown): value is Row => isRecord(value) && typeof value.id === 'number'

describe('isRecord', () => {
  it('accepts plain objects only', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ code: 'PGRST301' })).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord([])).toBe(false)
    expect(isRecord('row')).toBe(false)
    expect(isRecord(1)).toBe(false)
  })
})

describe('asList and listOrEmpty', () => {
  it('keeps only items that pass the guard', () => {
    expect(asList([{ id: 1 }, { id: '2' }, null, { id: 3 }], isRow)).toEqual([{ id: 1 }, { id: 3 }])
  })

  it('returns null for anything that is not an array, such as a Supabase error object', () => {
    expect(asList({ code: '42501', message: 'permission denied' }, isRow)).toBeNull()
    expect(asList(null, isRow)).toBeNull()
    expect(asList('[]', isRow)).toBeNull()
  })

  it('turns a missing or malformed list into an empty one', () => {
    expect(listOrEmpty(undefined, isRow)).toEqual([])
    expect(listOrEmpty({ message: 'oops' }, isRow)).toEqual([])
    expect(listOrEmpty([{ id: 1 }], isRow)).toEqual([{ id: 1 }])
  })
})

describe('readList', () => {
  const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } })

  it('reads a JSON array and filters it', async () => {
    await expect(readList(json('[{"id":1},{"nope":true}]'), isRow, 'failed')).resolves.toEqual([{ id: 1 }])
  })

  it('throws the given message for an error status even if the body is a list', async () => {
    await expect(readList(json('[]', 500), isRow, 'Could not load.')).rejects.toThrow('Could not load.')
  })

  it('throws when the body is an error object', async () => {
    await expect(readList(json('{"code":"PGRST116"}'), isRow, 'Could not load.')).rejects.toThrow('Could not load.')
  })

  it('throws when the body is not JSON', async () => {
    await expect(readList(new Response('<html>Bad gateway</html>'), isRow, 'Could not load.')).rejects.toThrow('Could not load.')
  })
})
