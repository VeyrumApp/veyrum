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
 *
 * Two refinements keep private helpers from invalidating every importer of a module:
 *
 * - a module-level function that never escapes (every reference to it is a direct call, it is not
 *   exported, and the module uses no `eval` or `with`) is left out of the top level entirely. Its
 *   length, name and kind can only be observed by calling it, which executes it, so its own unit
 *   covers every test that could notice a change;
 * - every unit records what each name it mentions resolves to at module level (a function, a
 *   variable, an import, or nothing, meaning a global). Adding, removing or retyping a module-level
 *   binding therefore changes exactly the units that mention its name.
 *
 * Code instrumented for Istanbul coverage (Jest's default provider, Vitest's istanbul provider)
 * fingerprints like the same code uninstrumented: the coverage function and its counters are left
 * out, and three equivalences Istanbul relies on are applied to all code alike. An arrow function
 * whose body only returns a value is its expression form, a block holding one statement in a
 * branch or loop body is that statement, and an empty `else` is none. Parentheses are dropped: the
 * tree's shape already holds the grouping. Chains of `&&`, `||` or `??` are associative and read as
 * one left-to-right chain.
 */

/** Bump when unit naming or canonicalization changes: fingerprints of different versions never match. */
export const FINGERPRINT_VERSION = '3'

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

/** Keys of statements whose body is a branch or loop body (see `branch` in fingerprintModule). */
const BRANCH_KEYS: Readonly<Record<string, readonly string[]>> = {
  IfStatement: ['consequent', 'alternate'],
  ForStatement: ['body'],
  ForInStatement: ['body'],
  ForOfStatement: ['body'],
  WhileStatement: ['body'],
  DoWhileStatement: ['body'],
  LabeledStatement: ['body'],
}

/** Declarations that cannot stand alone as a branch or loop body. */
function lexicalDeclaration(node: AstNode): boolean {
  return (
    (node.type === 'VariableDeclaration' && node.kind !== 'var') ||
    node.type === 'ClassDeclaration' ||
    node.type === 'FunctionDeclaration'
  )
}

/**
 * Istanbul's coverage function (`function cov_<hash>() { ... var coverageData = ... }` at module
 * level), which holds the file's coverage map and a hash of its source.
 */
function istanbulCoverageFunction(program: AstNode): AstNode | null {
  for (const stmt of program.body as AstNode[]) {
    if (stmt.type !== 'FunctionDeclaration') continue
    const id = stmt.id as AstNode | null
    if (id?.type !== 'Identifier' || !/^cov_[0-9a-z]+$/.test(id.name as string)) continue
    const body = (stmt.body as AstNode).body as AstNode[]
    const declares = (name: string): boolean =>
      body.some(
        (st) =>
          st.type === 'VariableDeclaration' &&
          (st.declarations as AstNode[]).some((d) => (d.id as AstNode).name === name),
      )
    if (declares('coverageData') && declares('hash')) return stmt
  }
  return null
}

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

  // Istanbul's instrumentation: its coverage function, calls to it, and counters it returns.
  const coverageFn = istanbulCoverageFunction(program)
  const coverageName = coverageFn ? ((coverageFn.id as AstNode).name as string) : null
  const isCoverageCall = (n: unknown): boolean =>
    coverageName !== null &&
    isNode(n) &&
    n.type === 'CallExpression' &&
    isNode(n.callee) &&
    n.callee.type === 'Identifier' &&
    n.callee.name === coverageName
  const isCounter = (n: unknown): boolean => {
    if (coverageName === null || !isNode(n) || n.type !== 'UpdateExpression') return false
    let target = n.argument as AstNode
    while (target.type === 'MemberExpression') target = target.object as AstNode
    return isCoverageCall(target)
  }
  const instrumentation = (n: unknown): boolean =>
    isNode(n) &&
    (n === coverageFn ||
      (n.type === 'ExpressionStatement' && (isCounter(n.expression) || isCoverageCall(n.expression))))
  const statements = (block: AstNode): AstNode[] =>
    (block.body as AstNode[]).filter((st) => !instrumentation(st))
  /** Parentheses and Istanbul's counter sequences around an expression, removed. */
  const unwrap = (node: AstNode): AstNode => {
    if (node.type === 'ParenthesizedExpression') return unwrap(node.expression as AstNode)
    if (node.type === 'SequenceExpression') {
      const expressions = (node.expressions as AstNode[]).filter((e) => !isCounter(e))
      if (expressions.length === 1) return unwrap(expressions[0]!)
    }
    return node
  }
  const canonicalOf = new WeakMap<AstNode, AstNode>()
  /** A node as it is fingerprinted: see the equivalences in the module comment. */
  const canonical = (node: AstNode): AstNode => {
    let out = canonicalOf.get(node)
    if (out) return out
    out = canonicalize(node)
    canonicalOf.set(node, out)
    // The canonical form of a canonical form is itself.
    canonicalOf.set(out, out)
    return out
  }
  const canonicalize = (node: AstNode): AstNode => {
    const inner = unwrap(node)
    if (inner !== node) return canonical(inner)
    if (node.type === 'SequenceExpression') {
      const expressions = (node.expressions as AstNode[]).filter((e) => !isCounter(e))
      return expressions.length === (node.expressions as AstNode[]).length ? node : { ...node, expressions }
    }
    if (node.type === 'LogicalExpression') {
      // `a && (b && c)` is `(a && b) && c`, and likewise for `||` and `??`: one left-to-right chain.
      const operator = node.operator
      const operands: AstNode[] = []
      const flatten = (n: AstNode): void => {
        const u = unwrap(n)
        if (u.type === 'LogicalExpression' && u.operator === operator) {
          flatten(u.left as AstNode)
          flatten(u.right as AstNode)
        } else operands.push(u)
      }
      flatten(node)
      return operands.slice(1).reduce<AstNode>((left, right) => {
        const link: AstNode = {
          type: 'LogicalExpression',
          operator,
          left,
          right,
          start: node.start,
          end: node.end,
        }
        canonicalOf.set(link, link)
        return link
      }, operands[0]!)
    }
    if (node.type === 'ArrowFunctionExpression' && !node.expression) {
      const body = statements(node.body as AstNode)
      const only = body[0]
      if (body.length === 1 && only?.type === 'ReturnStatement' && only.argument)
        return { ...node, expression: true, body: only.argument }
    }
    return node
  }
  /** A branch or loop body: a block of one statement is that statement, an empty `else` none. */
  const branch = (node: AstNode, key: string): AstNode | null => {
    if (node.type !== 'BlockStatement') return node
    const body = statements(node)
    if (key === 'alternate' && body.length === 0) return null
    const only = body[0]
    if (body.length === 1 && only && !lexicalDeclaration(only)) return canonical(only)
    return node
  }

  const bindings = moduleBindings(program)
  const private_ = nonEscapingFunctions(program, bindings)
  // The top-level declarations left out of the top-level unit (see the module comment): only the
  // module's own statements, never a same-named declaration in a nested block.
  const omittedNodes = new Set<AstNode>()
  for (const stmt of program.body as AstNode[]) {
    if (stmt.type === 'FunctionDeclaration') {
      const id = stmt.id as AstNode | null
      if (id?.type === 'Identifier' && private_.has(id.name as string)) omittedNodes.add(stmt)
    } else if (stmt.type === 'VariableDeclaration' && stmt.kind === 'const') {
      const declarations = stmt.declarations as AstNode[]
      for (const d of declarations) {
        const id = d.id as AstNode
        if (id.type === 'Identifier' && private_.has(id.name as string)) omittedNodes.add(d)
      }
      if (declarations.every((d) => omittedNodes.has(d))) omittedNodes.add(stmt)
    }
  }
  const omitted = (node: AstNode): boolean => omittedNodes.has(node)

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
    if (node === coverageFn) return
    // Parentheses and Istanbul's counter sequences are transparent: a function inside one is named
    // for the context around it, as it is without them.
    const inner = unwrap(node)
    if (inner !== node) {
      walk(inner, parent, key, unitPath)
      return
    }
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
    const mentioned = new Set<string>()
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
          // Omitted declarations leave no trace, not even a slot in the list.
          if (self === null && isNode(item) && omitted(item)) continue
          if (instrumentation(item)) continue
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
      // Canonical form; a nested function it turns out to be (a counter's sequence around it) is
      // written as a signature, the unit's own function in full.
      const n = canonical(v)
      if (v !== self && isFunction(n)) {
        out.push(signature(n, normIdent))
        return
      }
      if (n.type === 'Identifier') {
        const name = n.name as string
        if (!aliases.has(name)) mentioned.add(name)
        out.push('I(', normIdent(name), ')')
        return
      }
      if (n.type === 'CallExpression' && isSsrImport(n)) {
        out.push('{SsrImport ', ssrImportText(n, normSpec), '}')
        return
      }
      if (n.type === 'Literal') {
        out.push('L(', literalText(n, normString), ')')
        return
      }
      out.push('{', n.type)
      const branches = BRANCH_KEYS[n.type]
      for (const k in n) {
        if (SKIP_KEYS.has(k)) continue
        out.push(' ', k, ':')
        const child = n[k]
        write(branches?.includes(k) && isNode(child) ? branch(child, k) : child)
      }
      out.push('}')
    }
    write(rootNode)
    // What each mentioned name resolves to at module level.
    out.push('|')
    for (const name of [...mentioned].sort()) out.push(name, '=', bindings.get(name) ?? 'global', ';')
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

/** Names declared at module level and what they are (`fn`, `class`, `var`, `let`, `const`, `import`). */
function moduleBindings(program: AstNode): Map<string, string> {
  const out = new Map<string, string>()
  const declare = (node: AstNode | null | undefined): void => {
    if (!node) return
    switch (node.type) {
      case 'FunctionDeclaration':
      case 'ClassDeclaration': {
        const id = node.id as AstNode | null
        if (id?.type === 'Identifier')
          out.set(id.name as string, node.type === 'FunctionDeclaration' ? 'fn' : 'class')
        return
      }
      case 'VariableDeclaration':
        for (const d of node.declarations as AstNode[])
          for (const name of patternNames(d.id as AstNode)) out.set(name, node.kind as string)
        return
      case 'ImportDeclaration':
        for (const spec of (node.specifiers as AstNode[]) ?? []) {
          const local = spec.local as AstNode
          if (local?.type === 'Identifier') out.set(local.name as string, 'import')
        }
        return
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        declare(node.declaration as AstNode | null)
        return
    }
  }
  for (const stmt of program.body as AstNode[]) declare(stmt)
  return out
}

function patternNames(pattern: AstNode | null | undefined): string[] {
  if (!pattern) return []
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name as string]
    case 'ObjectPattern':
      return (pattern.properties as AstNode[]).flatMap((p) =>
        p.type === 'RestElement' ? patternNames(p.argument as AstNode) : patternNames(p.value as AstNode),
      )
    case 'ArrayPattern':
      return (pattern.elements as (AstNode | null)[]).flatMap((e) => patternNames(e))
    case 'RestElement':
      return patternNames(pattern.argument as AstNode)
    case 'AssignmentPattern':
      return patternNames(pattern.left as AstNode)
    default:
      return []
  }
}

/**
 * Module-level functions (declarations, and `const` bindings initialized with a function) whose every
 * mention anywhere in the module is the callee of a plain call. A function that is exported, passed,
 * stored, constructed with `new`, used as a tag, or mentioned any other way escapes. Mentions are
 * counted by name, ignoring scopes: a shadowing local mentioned in another way also counts, which
 * only errs toward escaping. Modules using `eval` or `with` have no private functions.
 */
function nonEscapingFunctions(program: AstNode, bindings: ReadonlyMap<string, string>): Set<string> {
  const candidates = new Set<string>()
  for (const stmt of program.body as AstNode[]) {
    if (stmt.type === 'FunctionDeclaration') {
      const id = stmt.id as AstNode | null
      if (id?.type === 'Identifier') candidates.add(id.name as string)
    } else if (stmt.type === 'VariableDeclaration' && stmt.kind === 'const') {
      for (const d of stmt.declarations as AstNode[]) {
        const id = d.id as AstNode
        const init = d.init as AstNode | null
        if (
          id.type === 'Identifier' &&
          init &&
          (init.type === 'FunctionExpression' || init.type === 'ArrowFunctionExpression')
        )
          candidates.add(id.name as string)
      }
    }
  }
  // A name declared twice at module level (a function and a variable) is left alone.
  for (const name of candidates)
    if (bindings.get(name) !== 'fn' && bindings.get(name) !== 'const') candidates.delete(name)
  if (candidates.size === 0) return candidates
  const escaped = new Set<string>()
  let dynamicScope = false
  const visit = (node: AstNode, parent: AstNode | undefined, key: string | undefined): void => {
    if (node.type === 'WithStatement') dynamicScope = true
    if (node.type === 'Identifier') {
      const name = node.name as string
      if (name === 'eval') dynamicScope = true
      if (
        candidates.has(name) &&
        !notAReference(parent, key) &&
        !(parent?.type === 'CallExpression' && key === 'callee')
      )
        escaped.add(name)
      return
    }
    for (const k in node) {
      if (SKIP_KEYS.has(k)) continue
      const v = node[k]
      if (Array.isArray(v)) {
        for (const item of v) if (isNode(item)) visit(item, node, k)
      } else if (isNode(v)) {
        visit(v, node, k)
      }
    }
  }
  visit(program, undefined, undefined)
  if (dynamicScope) return new Set()
  for (const name of escaped) candidates.delete(name)
  return candidates
}

/** Identifier positions that name something other than a variable reference, or declare one. */
function notAReference(parent: AstNode | undefined, key: string | undefined): boolean {
  if (!parent) return false
  switch (parent.type) {
    case 'MemberExpression':
      return key === 'property' && !parent.computed
    case 'Property':
      return key === 'key' && !parent.computed && !parent.shorthand
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return key === 'key' && !parent.computed
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return key === 'label'
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ClassDeclaration':
    case 'ClassExpression':
      return key === 'id'
    case 'VariableDeclarator':
      return key === 'id'
    case 'MetaProperty':
      return true
    default:
      return false
  }
}

function isSsrImport(call: AstNode): boolean {
  const callee = call.callee as AstNode
  return callee.type === 'Identifier' && callee.name === SSR_IMPORT
}

/**
 * Vite's SSR import with its metadata. The names a module imports are checked against the imported
 * module only when that module is an externalized dependency (a CommonJS package can lack a named
 * export); for repository modules the list has no effect, so it is left out.
 */
function ssrImportText(call: AstNode, normSpec: (s: string) => string): string {
  const [spec, meta] = call.arguments as AstNode[]
  const value = spec?.type === 'Literal' && typeof spec.value === 'string' ? spec.value : null
  const external =
    value === null ||
    value.includes('/node_modules/') ||
    !(value.startsWith('/') || value.startsWith('.') || /^[A-Za-z]:[\\/]/.test(value))
  let names = ''
  if (external && meta?.type === 'ObjectExpression') {
    for (const p of meta.properties as AstNode[]) {
      const k = p.key as AstNode | undefined
      if (p.type === 'Property' && k?.type === 'Identifier' && k.name === 'importedNames') {
        const arr = p.value as AstNode
        if (arr.type === 'ArrayExpression')
          names = (arr.elements as AstNode[])
            .map((e) => (e?.type === 'Literal' ? String(e.value) : '?'))
            .join(',')
        else names = '?'
      }
    }
  }
  return `${value === null ? '?' : normSpec(value)} [${names}]`
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
