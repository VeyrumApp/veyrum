import { createHash } from 'node:crypto'

/** A short, collision-resistant content digest (132 bits, base64url). */
export type Digest = string

export function digest(data: string | Uint8Array): Digest {
  return createHash('sha256').update(data).digest('base64url').slice(0, 22)
}

/** Digest of several parts, unambiguous regardless of part contents. */
export function digestParts(parts: readonly (string | number | boolean | null | undefined)[]): Digest {
  const h = createHash('sha256')
  for (const part of parts) {
    const s = part === null || part === undefined ? '\u0000' : String(part)
    h.update(`${s.length}:`)
    h.update(s)
  }
  return h.digest('base64url').slice(0, 22)
}
