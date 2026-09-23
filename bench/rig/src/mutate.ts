import { parseSync } from 'oxc-parser'

/** A single-site source mutation. Offsets are UTF-16 indices into the file text. */
export interface Mutant {
  readonly file: string
  readonly start: number
  readonly end: number
  readonly replacement: string
  readonly kind: string
  readonly line: number
}

type AstNode = { type: string; start: number; end: number; [key: string]: unknown }

const BINARY_SWAPS: Record<string, string> = {
  '+': '-',
  '-': '+',
  '*': '/',
  '/': '*',
  '<': '<=',
  '<=': '<',
  '>': '>=',
  '>=': '>',
  '===': '!==',
  '!==': '===',
  '==': '!=',
  '!=': '==',
}
const LOGICAL_SWAPS: Record<string, string> = { '&&': '||', '||': '&&', '??': '||' }

function isNode(v: unknown): v is AstNode {
  return typeof v === 'object' && v !== null && typeof (v as AstNode).type === 'string'
}

/** Every mutation site in a TypeScript or JavaScript file (outside type annotations). */
export function mutationSites(file: string, code: string): Mutant[] {
  let program: AstNode
  try {
    const result = parseSync(file, code, { sourceType: 'module' })
    if (result.errors.length > 0) return []
    program = result.program as unknown as AstNode
  } catch {
    return []
  }
  const lineOf = (offset: number): number => code.slice(0, offset).split('\n').length
  const sites: Mutant[] = []
  const operatorSite = (node: AstNode, table: Record<string, string>, kind: string): void => {
    const op = node.operator as string
    const swap = table[op]
    const left = node.left as AstNode
    const right = node.right as AstNode
    if (!swap || !left || !right) return
    const between = code.slice(left.end, right.start)
    const at = between.indexOf(op)
    if (at < 0) return
    const start = left.end + at
    sites.push({
      file,
      start,
      end: start + op.length,
      replacement: swap,
      kind: `${kind} ${op} -> ${swap}`,
      line: lineOf(start),
    })
  }
  const walk = (node: AstNode, inType: boolean): void => {
    const typeContext = inType || node.type.startsWith('TS')
    if (!typeContext) {
      switch (node.type) {
        case 'BinaryExpression':
          operatorSite(node, BINARY_SWAPS, 'binary')
          break
        case 'LogicalExpression':
          operatorSite(node, LOGICAL_SWAPS, 'logical')
          break
        case 'Literal':
          if (typeof node.value === 'boolean') {
            sites.push({
              file,
              start: node.start,
              end: node.end,
              replacement: String(!node.value),
              kind: `boolean ${node.value}`,
              line: lineOf(node.start),
            })
          }
          break
        case 'IfStatement': {
          const test = node.test as AstNode
          sites.push({
            file,
            start: test.start,
            end: test.end,
            replacement: `!(${code.slice(test.start, test.end)})`,
            kind: 'negate condition',
            line: lineOf(test.start),
          })
          break
        }
        default:
          break
      }
    }
    for (const key in node) {
      if (key === 'start' || key === 'end' || key === 'type') continue
      const value = node[key]
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) walk(item, typeContext)
      } else if (isNode(value)) {
        walk(value, typeContext)
      }
    }
  }
  walk(program, false)
  return sites
}

export function applyMutant(code: string, mutant: Mutant): string {
  return code.slice(0, mutant.start) + mutant.replacement + code.slice(mutant.end)
}

/** Small deterministic PRNG (mulberry32) so replays are reproducible. */
export function rng(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
