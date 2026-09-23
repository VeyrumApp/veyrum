import { parseSync } from 'oxc-parser'
import { type Digest, digest } from './hash.ts'

/**
 * Unit fingerprints over the code V8 actually executed.
 *
 * A module is split into units: the module top level plus every function-like node. A unit's
 * fingerprint is a digest of its canonical AST where every nested function is replaced by its
 * signature (kind, name, async, generator, parameter shapes) and its body is left out. So:
 *
 * - editing the body of a function changes only that function's unit;
 * - changing a function's arity, name or kind changes the enclosing unit (callers can observe
 *   `fn.length` and `fn.name`);
 * - comments, whitespace and quote style never change a fingerprint (positions and `raw` text are
 *   dropped), except where a test observes source text, which the capture layer detects and then
 *   compares raw source instead;
 * - class field initializers and static blocks belong to the enclosing unit, because V8 runs them
 *   as part of the class definition.
 */

export const TOP_UNIT = '@top'
export const OPAQUE_UNIT = '@opaque'

export interface UnitInfo {
  readonly path: string
  readonly start: number
  readonly end: number
  readonly fp: Digest
}

export interface ModuleUnits {
  /** Every unit in the module, keyed by unit path. Always contains `@top` or `@opaque`. */
  readonly units: ReadonlyMap<string, UnitInfo>
  /** True when the code could not be parsed; the whole module is then a single unit. */
  readonly opaque: boolean
  /** Maps an executed V8 function range to the unit path that owns it. */
  locate(start: number, end: number): string
}

export interface FingerprintOptions {
  /** Absolute repository root. Occurrences inside string literals are replaced with `<root>`. */
  readonly root?: string
}

type AstNode = { type: string; start: number; end: number; [key: string]: unknown }

const SKIP_KEYS = new Set(['type', 'start', 'end', 'range', 'loc', 'parent'])
const SSR_IMPORT = '__vite_ssr_import__'
const SSR_DYNAMIC_IMPORT = '__vite_ssr_dynamic_import__'

function isNode(v: unknown): v is AstNode {
  return typeof v === 'object' && v !== null && typeof (v as AstNode).type === 'string'
}

function isFunction(n: AstNode): boolean {
  return (
    n.type === 'FunctionDeclaration' ||
    n.type === 'FunctionExpression' ||
    n.type === 'ArrowFunctionExpression'
  )
}

export function fingerprintModule(code: string, options: FingerprintOptions = {}): ModuleUnits {
  let program: AstNode
  try {
    // ES modules first; CommonJS (Jest's compiled modules) allows top-level return.
    let result = parseSync('module.js', code, { sourceType: 'module', lang: 'js' })
    if (result.errors.length > 0)
      result = parseSync('module.js', code, { sourceType: 'commonjs', lang: 'js' })
    if (result.errors.length > 0) return opaqueModule(code)
    program = result.program as unknown as AstNode
  } catch {
    return opaqueModule(code)
  }

  const root = options.root
  const aliases = collectImportAliases(program)
  const normString = (s: string): string => (root && s.includes(root) ? s.split(root).join('<root>') : s)
  // Specifiers into node_modules carry install paths (pnpm store, machine root); keep the package path.
  const normSpec = (spec: string): string => {
    const at = spec.lastIndexOf('/node_modules/')
    return at >= 0 ? spec.slice(at + 1) : normString(spec)
  }
  const normIdent = (name: string): string => {
    const spec = aliases.get(name)
    return spec === undefined ? name : `import(${normSpec(spec)})`
  }

  // Pass 1: find function nodes and give each a stable unit path.
  const functions: { node: AstNode; path: string }[] = []
  const counters = new Map<string, number>()
  const nameOf = (fn: AstNode, parent: AstNode | undefined, key: string | undefined): string => {
    const id = fn.id as AstNode | null | undefined
    if (id && id.type === 'Identifier') return `fn:${id.name as string}`
    if (!parent) return 'anon'
    switch (parent.type) {
      case 'MethodDefinition': {
        const kind =
          parent.kind === 'method' || parent.kind === 'constructor' ? '' : `${parent.kind as string} `
        return `m:${parent.static ? 'static ' : ''}${kind}${keyText(parent.key, parent.computed, normIdent)}`
      }
      case 'Property': {
        const kind = parent.kind === 'init' ? '' : `${parent.kind as string} `
        return `p:${kind}${keyText(parent.key, parent.computed, normIdent)}`
      }
      case 'PropertyDefinition':
        return `f:${parent.static ? 'static ' : ''}${keyText(parent.key, parent.computed, normIdent)}`
      case 'VariableDeclarator':
        return key === 'init' ? `v:${exprText(parent.id, normIdent)}` : 'anon'
      case 'AssignmentExpression':
        return key === 'right' ? `a:${exprText(parent.left, normIdent)}` : 'anon'
      case 'CallExpression':
      case 'NewExpression': {
        const args = parent.arguments as AstNode[]
        const first = args[0]
        const label =
          first && first.type === 'Literal' && typeof first.value === 'string'
            ? `(${JSON.stringify(first.value.slice(0, 80))})`
            : '()'
        return `c:${exprText(parent.callee, normIdent)}${label}`
      }
      case 'ExportDefaultDeclaration':
        return 'default'
      default:
        return 'anon'
    }
  }

  const walk = (
    node: AstNode,
    parent: AstNode | undefined,
    key: string | undefined,
    unitPath: string,
  ): void => {
    let here = unitPath
    if (isFunction(node)) {
      const name = nameOf(node, parent, key)
      const counterKey = `${unitPath}\u0000${name}`
      const ordinal = counters.get(counterKey) ?? 0
      counters.set(counterKey, ordinal + 1)
      here = `${unitPath}/${name}#${ordinal}`
      functions.push({ node, path: here })
    }
    for (const k in node) {
      if (SKIP_KEYS.has(k)) continue
      const v = node[k]
      if (Array.isArray(v)) {
        for (const item of v) if (isNode(item)) walk(item, node, k, here)
      } else if (isNode(v)) {
        walk(v, node, k, here)
      }
    }
  }
  walk(program, undefined, undefined, TOP_UNIT)

  // Pass 2: canonical serialization per unit.
  const serialize = (self: AstNode | null, rootNode: AstNode): string => {
    const out: string[] = []
    const write = (v: unknown): void => {
      if (v === null || v === undefined) {
        out.push('_')
        return
      }
      if (typeof v !== 'object') {
        out.push(JSON.stringify(typeof v === 'string' ? normString(v) : v))
        return
      }
      if (Array.isArray(v)) {
        out.push('[')
        for (const item of v) {
          write(item)
          out.push(',')
        }
        out.push(']')
        return
      }
      if (!isNode(v)) {
        out.push('{')
        for (const k in v as Record<string, unknown>) {
          out.push(k, ':')
          write((v as Record<string, unknown>)[k])
          out.push(';')
        }
        out.push('}')
        return
      }
      if (v !== self && isFunction(v)) {
        out.push(signature(v, normIdent))
        return
      }
      if (v.type === 'Identifier') {
        out.push('I(', normIdent(v.name as string), ')')
        return
      }
      if (v.type === 'Literal') {
        out.push('L(', literalText(v, normString), ')')
        return
      }
      out.push('{', v.type)
      for (const k in v) {
        if (SKIP_KEYS.has(k)) continue
        out.push(' ', k, ':')
        write(v[k])
      }
      out.push('}')
    }
    write(rootNode)
    return out.join('')
  }

  const list: UnitInfo[] = [
    { path: TOP_UNIT, start: 0, end: code.length, fp: digest(serialize(null, program)) },
  ]
  for (const { node, path } of functions) {
    list.push({ path, start: node.start, end: node.end, fp: digest(serialize(node, node)) })
  }
  return moduleUnitsOf(list, false)
}

/** Builds the unit lookup (including V8 range location) from a unit list. */
export function moduleUnitsOf(list: readonly UnitInfo[], opaque: boolean): ModuleUnits {
  const units = new Map<string, UnitInfo>()
  const byEnd = new Map<number, UnitInfo[]>()
  for (const info of list) {
    units.set(info.path, info)
    if (info.path === TOP_UNIT || info.path === OPAQUE_UNIT) continue
    const bucket = byEnd.get(info.end)
    if (bucket) bucket.push(info)
    else byEnd.set(info.end, [info])
  }
  const nested = list.filter((u) => u.path !== TOP_UNIT && u.path !== OPAQUE_UNIT)
  const fallback = opaque ? OPAQUE_UNIT : TOP_UNIT
  return {
    units,
    opaque,
    locate(start: number, end: number): string {
      if (opaque) return OPAQUE_UNIT
      const candidates = byEnd.get(end)
      if (candidates && candidates.length > 0) {
        let best = candidates[0]!
        for (const c of candidates) if (Math.abs(c.start - start) < Math.abs(best.start - start)) best = c
        return best.path
      }
      // Synthetic V8 functions (class member initializers, static initializers) and anything else
      // without a node of its own belong to the innermost unit that contains them.
      let innermost: UnitInfo | undefined
      for (const u of nested) {
        if (
          u.start <= start &&
          end <= u.end &&
          (!innermost || u.end - u.start < innermost.end - innermost.start)
        ) {
          innermost = u
        }
      }
      return innermost ? innermost.path : fallback
    },
  }
}

/** Compact serialization of a module's units, for caching fingerprints across runs. */
export function serializeUnits(m: ModuleUnits): string {
  return JSON.stringify({
    o: m.opaque ? 1 : 0,
    u: [...m.units.values()].map((u) => [u.path, u.start, u.end, u.fp]),
  })
}

export function deserializeUnits(text: string): ModuleUnits {
  const data = JSON.parse(text) as { o: number; u: [string, number, number, string][] }
  return moduleUnitsOf(
    data.u.map(([path, start, end, fp]) => ({ path, start, end, fp })),
    data.o === 1,
  )
}

function opaqueModule(code: string): ModuleUnits {
  return moduleUnitsOf([{ path: OPAQUE_UNIT, start: 0, end: code.length, fp: digest(code) }], true)
}

function collectImportAliases(program: AstNode): Map<string, string> {
  const aliases = new Map<string, string>()
  const seen = new Map<string, number>()
  for (const stmt of program.body as AstNode[]) {
    if (stmt.type !== 'VariableDeclaration') continue
    for (const decl of stmt.declarations as AstNode[]) {
      const id = decl.id as AstNode
      let init = decl.init as AstNode | null
      if (!init || id.type !== 'Identifier') continue
      if (init.type === 'AwaitExpression') init = init.argument as AstNode
      if (init.type !== 'CallExpression') continue
      const callee = init.callee as AstNode
      if (callee.type !== 'Identifier' || (callee.name !== SSR_IMPORT && callee.name !== SSR_DYNAMIC_IMPORT))
        continue
      const spec = (init.arguments as AstNode[])[0]
      if (spec?.type !== 'Literal' || typeof spec.value !== 'string') continue
      const n = seen.get(spec.value) ?? 0
      seen.set(spec.value, n + 1)
      aliases.set(id.name as string, n === 0 ? spec.value : `${spec.value}#${n}`)
    }
  }
  return aliases
}

function signature(fn: AstNode, normIdent: (s: string) => string): string {
  const id = fn.id as AstNode | null | undefined
  const params = (fn.params as AstNode[]).map((p) => p.type).join('|')
  const name = id && id.type === 'Identifier' ? normIdent(id.name as string) : ''
  return `S(${fn.type},${fn.async ? 1 : 0},${fn.generator ? 1 : 0},${params},${name})`
}

function literalText(lit: AstNode, normString: (s: string) => string): string {
  const regex = lit.regex as { pattern: string; flags: string } | undefined
  if (regex) return `/${regex.pattern}/${regex.flags}`
  if (typeof lit.bigint === 'string') return `${lit.bigint}n`
  const value = lit.value
  return JSON.stringify(typeof value === 'string' ? normString(value) : (value ?? null))
}

function keyText(key: unknown, computed: unknown, normIdent: (s: string) => string): string {
  if (!isNode(key)) return '?'
  if (computed) return `[${exprText(key, normIdent)}]`
  if (key.type === 'Identifier') return key.name as string
  if (key.type === 'PrivateIdentifier') return `#${key.name as string}`
  if (key.type === 'Literal') return String(key.value)
  return '?'
}

function exprText(node: unknown, normIdent: (s: string) => string, depth = 0): string {
  if (!isNode(node) || depth > 6) return '?'
  switch (node.type) {
    case 'Identifier':
      return normIdent(node.name as string)
    case 'ThisExpression':
      return 'this'
    case 'PrivateIdentifier':
      return `#${node.name as string}`
    case 'Literal':
      return String(node.value)
    case 'MemberExpression': {
      const obj = exprText(node.object, normIdent, depth + 1)
      const prop = node.computed
        ? `[${exprText(node.property, normIdent, depth + 1)}]`
        : `.${exprText(node.property, normIdent, depth + 1)}`
      return `${obj}${prop}`
    }
    case 'CallExpression':
      return `${exprText(node.callee, normIdent, depth + 1)}()`
    case 'ParenthesizedExpression':
      return exprText(node.expression, normIdent, depth + 1)
    case 'SequenceExpression': {
      // `(0, obj.fn)(...)` is how bundlers call an imported function without a receiver.
      const expressions = node.expressions as AstNode[]
      return exprText(expressions[expressions.length - 1], normIdent, depth + 1)
    }
    default:
      return node.type
  }
}
