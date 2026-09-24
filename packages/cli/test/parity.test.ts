import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Sandbox } from '../../../test/support/sandbox.ts'

let sandbox: Sandbox | undefined
afterEach(() => sandbox?.dispose())

/** What a test sees of its process, and of a Node program it starts. */
const probe = `const fs = require('fs')
const { execFileSync } = require('child_process')
const child = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ env: process.env, execArgv: process.execArgv }))'])
fs.writeFileSync(process.env.PROBE_FILE, JSON.stringify({ env: process.env, execArgv: process.execArgv, child: JSON.parse(child.toString()) }))
`

interface Seen {
  env: Record<string, string>
  execArgv: string[]
  child: { env: Record<string, string>; execArgv: string[] }
}

const changed = (a: Record<string, string>, b: Record<string, string>): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => a[k] !== b[k] && k !== 'PROBE_FILE')
    .sort()

/** The variables child-process tracing gives the programs a test starts (see trace.ts). */
const TRACER_VARIABLES = ['DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'UV_USE_IO_URING', 'VEYRUM_TRACE']

describe.each(['vitest', 'jest'] as const)('under Veyrum (%s)', (runner) => {
  test('a test sees the process it would under the plain runner', () => {
    sandbox = new Sandbox('parity', { runner })
    if (runner === 'jest') sandbox.write('test/probe.test.js', `test('probe', () => {\n${probe}})\n`)
    else
      sandbox.write(
        'test/probe.test.ts',
        `import { createRequire } from 'node:module'\nimport { test } from 'vitest'\nconst require = createRequire(import.meta.url)\ntest('probe', () => {\n${probe}})\n`,
      )
    const file = (name: string) => path.join(sandbox!.dir, name)
    const bin =
      runner === 'jest'
        ? [file('node_modules/jest/bin/jest.js')]
        : [file('node_modules/vitest/vitest.mjs'), 'run']
    const env: NodeJS.ProcessEnv = { ...process.env, PROBE_FILE: file('plain.json') }
    for (const k of Object.keys(env))
      if (/^(VITEST|JEST)|^(NODE_ENV|TEST|CI|GITHUB_ACTIONS)$/.test(k) && k !== 'PROBE_FILE') delete env[k]
    expect(spawnSync(process.execPath, bin, { cwd: sandbox.dir, env }).status).toBe(0)
    const r = sandbox.raw(['run', '--full'], { PROBE_FILE: file('veyrum.json') })
    if (r.code !== 0) console.log(r.output.slice(-3000))
    expect(r.code).toBe(0)
    const plain = JSON.parse(fs.readFileSync(file('plain.json'), 'utf8')) as Seen
    const veyrum = JSON.parse(fs.readFileSync(file('veyrum.json'), 'utf8')) as Seen
    expect(changed(plain.env, veyrum.env)).toEqual([])
    expect(veyrum.execArgv).toEqual(plain.execArgv)
    expect(veyrum.child.execArgv).toEqual(plain.child.execArgv)
    const childChanges = changed(plain.child.env, veyrum.child.env)
    expect(childChanges.filter((k) => !TRACER_VARIABLES.includes(k))).toEqual([])
  })
})
