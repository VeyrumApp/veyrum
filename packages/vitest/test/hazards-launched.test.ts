import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { goTool, install, staticTool } from '../../../test/support/programs.ts'
import { Sandbox } from '../../../test/support/sandbox.ts'
import { TRACED_PLATFORMS } from '../../capture/src/trace.ts'

/**
 * Statically linked and Go programs, which make system calls themselves: the preloaded tracer
 * cannot see them, so they run under veyrum-exec's ptrace tracer. What they read is an input like
 * anything a traced program reads.
 */

let sandbox: Sandbox | undefined
afterEach(() => sandbox?.dispose())

const launcher = path.resolve(fileURLToPath(import.meta.url), '../../../capture/dist/native/veyrum-exec')
const tracing = TRACED_PLATFORMS.includes(`${process.platform}-${process.arch}`)
const tool = tracing ? staticTool() : null
const go = tracing ? goTool() : null

const spawnTest = (body: string): string =>
  `import { execFileSync, execSync, spawnSync } from 'node:child_process'\nimport { expect, test } from 'vitest'\ntest('child', () => {\n${body}\n})\n`
const plain = "import { expect, test } from 'vitest'\ntest('plain', () => expect(1).toBe(1))\n"

describe.runIf(tracing)('statically linked programs', () => {
  // Where tracing is built, so is the launcher: without it these programs would block reuse.
  test('the launcher and a static test program build here', () => {
    expect(fs.existsSync(launcher)).toBe(true)
    expect(tool).not.toBeNull()
  })

  test.runIf(tool)(
    'what a static program reads, lists and checks is an input of the file that started it',
    () => {
      sandbox = new Sandbox('static-read')
        .write('fixtures/x.txt', 'a')
        .write('fixtures/other.txt', 'o')
        .write('fixtures/dir/one', '1')
        .write(
          'test/child.test.ts',
          spawnTest(
            "  const out = execFileSync('./fixtures/tool', ['read', 'fixtures/x.txt', 'list', 'fixtures/dir', 'stat', 'fixtures/later']).toString()\n  expect(out).toMatch(/^[ab]/)",
          ),
        )
        .write('test/plain.test.ts', plain)
      install(tool!, sandbox.dir, 'fixtures/tool')
      sandbox.capture()
      expect(sandbox.actions()).toEqual({ 'test/child.test.ts': 'skip', 'test/plain.test.ts': 'skip' })
      sandbox.write('fixtures/other.txt', 'p')
      expect(sandbox.actions()['test/child.test.ts']).toBe('skip')
      sandbox.write('fixtures/x.txt', 'b')
      expect(sandbox.plan()['test/child.test.ts']?.details).toEqual(['fixtures/x.txt changed'])
      sandbox.capture()
      sandbox.write('fixtures/dir/two', '2')
      expect(sandbox.actions()['test/child.test.ts']).toBe('run')
      sandbox.capture()
      sandbox.write('fixtures/later', '')
      expect(sandbox.actions()['test/child.test.ts']).toBe('run')
    },
  )

  test.runIf(tool)('reads from its threads and children, started by a traced program or itself', () => {
    sandbox = new Sandbox('static-nested')
      .write('fixtures/x.txt', 'a')
      .write('fixtures/y.txt', 'b')
      .write('fixtures/z.txt', 'c')
      .write(
        'test/child.test.ts',
        spawnTest(
          "  expect(execSync('./fixtures/tool thread fixtures/x.txt fork fixtures/y.txt').toString()).toBe('ab')\n  expect(execFileSync('./fixtures/tool', ['exec', './fixtures/reader']).toString()).toBe('c')",
        ),
      )
    install(tool!, sandbox.dir, 'fixtures/tool')
    // A program the static one executes, which is traced as it goes on.
    sandbox.write('fixtures/reader', '#!/bin/sh\nexec cat fixtures/z.txt\n')
    fs.chmodSync(`${sandbox.dir}/fixtures/reader`, 0o755)
    sandbox.capture()
    expect(sandbox.actions()['test/child.test.ts']).toBe('skip')
    for (const [file, content] of [
      ['fixtures/x.txt', 'a'],
      ['fixtures/y.txt', 'b'],
      ['fixtures/z.txt', 'c'],
    ] as const) {
      sandbox.write(file, 'changed')
      expect(sandbox.plan()['test/child.test.ts']?.details).toEqual([`${file} changed`])
      sandbox.write(file, content)
    }
  })

  test.runIf(tool)('it runs as it would untraced: argv[0], output and exit status', () => {
    sandbox = new Sandbox('static-behavior').write(
      'test/child.test.ts',
      spawnTest(
        "  expect(execFileSync('./fixtures/tool', ['argv0', '-']).toString()).toBe('./fixtures/tool\\n')\n  const r = spawnSync('./fixtures/tool', ['argv0', '-', 'exit', '3'], { argv0: 'named' })\n  expect([r.status, r.stdout.toString()]).toEqual([3, 'named\\n'])",
      ),
    )
    install(tool!, sandbox.dir, 'fixtures/tool')
    expect(sandbox.capture().code).toBe(0)
    expect(sandbox.actions()['test/child.test.ts']).toBe('skip')
  })
})

describe.runIf(tracing && go)('Go programs', () => {
  test('what a Go program reads from its goroutines is an input', () => {
    sandbox = new Sandbox('go-read')
      .write('fixtures/x.txt', 'a')
      .write('fixtures/y.txt', 'b')
      .write(
        'test/child.test.ts',
        spawnTest(
          "  expect(execFileSync('./fixtures/tool', ['fixtures/x.txt', 'fixtures/y.txt']).toString()).toBe('ab')",
        ),
      )
    install(go!, sandbox.dir, 'fixtures/tool')
    sandbox.capture()
    expect(sandbox.actions()['test/child.test.ts']).toBe('skip')
    sandbox.write('fixtures/y.txt', 'c')
    expect(sandbox.plan()['test/child.test.ts']?.details).toEqual(['fixtures/y.txt changed'])
  })
})
