import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { dynamicTool, install } from '../../../test/support/programs.ts'
import { Sandbox } from '../../../test/support/sandbox.ts'

/**
 * Child processes on macOS, traced by the library dyld inserts (packages/capture/native/
 * trace-darwin.c). Apple's own programs, the shell, cat and ls among them, and programs signed with
 * the hardened runtime do not load it: they run as shadow copies that do.
 */

let sandbox: Sandbox | undefined
afterEach(() => sandbox?.dispose())

const darwin = process.platform === 'darwin'
const tool = darwin ? dynamicTool() : null

const spawnTest = (body: string): string =>
  `import { execFileSync, execSync, spawnSync } from 'node:child_process'\nimport { expect, test } from 'vitest'\ntest('child', () => {\n${body}\n})\n`
const plain = "import { expect, test } from 'vitest'\ntest('plain', () => expect(1).toBe(1))\n"

describe.runIf(darwin)('macOS child processes', () => {
  test('a test program builds here', () => {
    expect(tool).not.toBeNull()
  })

  test('what a shell and the system programs it runs read is an input', () => {
    sandbox = new Sandbox('mac-shell-read')
      .write('fixtures/x.txt', 'a')
      .write('fixtures/other.txt', 'o')
      .write(
        'test/child.test.ts',
        spawnTest(
          "  expect(execSync('cat fixtures/x.txt').toString()).toMatch(/^[ab]$/)\n  expect(execSync('cat fixtures/x.txt | wc -c').toString().trim()).toBe('1')",
        ),
      )
      .write('test/plain.test.ts', plain)
    sandbox.capture()
    expect(sandbox.actions()).toEqual({ 'test/child.test.ts': 'skip', 'test/plain.test.ts': 'skip' })
    sandbox.write('fixtures/other.txt', 'p')
    expect(sandbox.actions()['test/child.test.ts']).toBe('skip')
    sandbox.write('fixtures/x.txt', 'b')
    expect(sandbox.plan()['test/child.test.ts']?.details).toEqual(['fixtures/x.txt changed'])
  })

  test('a directory a system program lists is an input, started directly or by a shell', () => {
    sandbox = new Sandbox('mac-list')
      .write('fixtures/dir/one', '1')
      .write('fixtures/shell/one', '1')
      .write(
        'test/child.test.ts',
        spawnTest(
          "  expect(execFileSync('/bin/ls', ['fixtures/dir']).toString()).toMatch(/^one\\n/)\n  expect(execSync('ls fixtures/shell').toString()).toMatch(/^one\\n/)",
        ),
      )
    sandbox.capture()
    expect(sandbox.actions()['test/child.test.ts']).toBe('skip')
    for (const dir of ['fixtures/dir', 'fixtures/shell']) {
      sandbox.write(`${dir}/two`, '2')
      expect(sandbox.actions()['test/child.test.ts'], dir).toBe('run')
      sandbox.capture()
      expect(sandbox.actions()['test/child.test.ts'], dir).toBe('skip')
    }
  })

  test.runIf(tool)('reads from threads, forks and grandchildren started through a script are inputs', () => {
    sandbox = new Sandbox('mac-nested')
      .write('fixtures/x.txt', 'a')
      .write('fixtures/y.txt', 'b')
      .write('fixtures/z.txt', 'c')
      .write(
        'test/child.test.ts',
        spawnTest(
          "  expect(execFileSync('./fixtures/tool', ['thread', 'fixtures/x.txt', 'fork', 'fixtures/y.txt']).toString()).toMatch(/^..$/)\n  expect(execFileSync('./fixtures/tool', ['exec', './fixtures/reader']).toString()).toMatch(/^.$/)",
        ),
      )
      // A script the program executes: its interpreter is a system shell, which runs cat.
      .write('fixtures/reader', '#!/bin/sh\nexec cat fixtures/z.txt\n')
    install(tool!, sandbox.dir, 'fixtures/tool')
    fs.chmodSync(path.join(sandbox.dir, 'fixtures/reader'), 0o755)
    sandbox.capture()
    expect(sandbox.actions()['test/child.test.ts']).toBe('skip')
    for (const [file, content] of [
      ['fixtures/x.txt', 'a'],
      ['fixtures/y.txt', 'b'],
      ['fixtures/z.txt', 'c'],
    ] as const) {
      sandbox.write(file, 'C')
      expect(sandbox.plan()['test/child.test.ts']?.details, file).toEqual([`${file} changed`])
      sandbox.write(file, content)
    }
  })

  test.runIf(tool)('programs run as they would untraced: argv[0], output and exit status', () => {
    sandbox = new Sandbox('mac-behavior').write(
      'test/child.test.ts',
      spawnTest(
        [
          "  expect(execFileSync('./fixtures/tool', ['argv0', '-']).toString()).toBe('./fixtures/tool\\n')",
          "  const r = spawnSync('./fixtures/tool', ['argv0', '-', 'exit', '3'], { argv0: 'named' })",
          "  expect([r.status, r.stdout.toString()]).toEqual([3, 'named\\n'])",
          "  expect(spawnSync('sh', ['-c', 'exit 7']).status).toBe(7)",
          "  expect(execSync('printf %s \"$0\"').toString()).toBe('/bin/sh')",
          "  expect(spawnSync('/bin/sh', ['-c', 'cat missing-file'], { stdio: 'pipe' }).status).toBe(1)",
        ].join('\n'),
      ),
    )
    install(tool!, sandbox.dir, 'fixtures/tool')
    expect(sandbox.capture().code).toBe(0)
    expect(sandbox.actions()['test/child.test.ts']).toBe('skip')
  })

  test.runIf(tool)('a program signed with the hardened runtime is traced through its shadow copy', () => {
    sandbox = new Sandbox('mac-hardened')
      .write('fixtures/x.txt', 'a')
      .write(
        'test/child.test.ts',
        spawnTest(
          "  expect(execFileSync('./fixtures/tool', ['read', 'fixtures/x.txt']).toString()).toMatch(/^.$/)",
        ),
      )
    install(tool!, sandbox.dir, 'fixtures/tool')
    const signed = spawnSync(
      'codesign',
      ['--force', '--sign', '-', '--options', 'runtime', 'fixtures/tool'],
      {
        cwd: sandbox.dir,
        stdio: 'pipe',
      },
    )
    expect(signed.status, signed.stderr.toString()).toBe(0)
    sandbox.capture()
    expect(sandbox.actions()['test/child.test.ts']).toBe('skip')
    sandbox.write('fixtures/x.txt', 'b')
    expect(sandbox.plan()['test/child.test.ts']?.details).toEqual(['fixtures/x.txt changed'])
  })

  test.runIf(tool)(
    'a protected program that loads libraries relative to itself runs as itself and blocks reuse',
    () => {
      sandbox = new Sandbox('mac-located')
        .write('fixtures/x.txt', 'a')
        .write(
          'test/child.test.ts',
          spawnTest(
            "  expect(execFileSync('./fixtures/tool', ['read', 'fixtures/x.txt']).toString()).toMatch(/^.$/)",
          ),
        )
      install(tool!, sandbox.dir, 'fixtures/tool')
      // A copy elsewhere would look for its libraries elsewhere: it is not made.
      for (const [program, args] of [
        ['install_name_tool', ['-add_rpath', '@executable_path/.', 'fixtures/tool']],
        ['codesign', ['--force', '--sign', '-', '--options', 'runtime', 'fixtures/tool']],
      ] as const) {
        const r = spawnSync(program, args, { cwd: sandbox.dir, stdio: 'pipe' })
        expect(r.status, r.stderr.toString()).toBe(0)
      }
      expect(sandbox.capture().code).toBe(0)
      const decision = sandbox.plan()['test/child.test.ts']
      expect(decision?.reason).toBe('blocked-flag')
      expect(decision?.details[0]).toMatch(/spawn \(.*fixtures\/tool\)$/)
    },
  )

  test('a set-user-ID program cannot be traced and blocks reuse, started directly or by a shell', () => {
    sandbox = new Sandbox('mac-setuid')
      .write('test/direct.test.ts', spawnTest("  execFileSync('./fixtures/setuid')\n  expect(1).toBe(1)"))
      .write('test/nested.test.ts', spawnTest("  execSync('./fixtures/setuid')\n  expect(1).toBe(1)"))
      .write('test/plain.test.ts', plain)
    fs.mkdirSync(path.join(sandbox.dir, 'fixtures'), { recursive: true })
    fs.copyFileSync('/usr/bin/true', path.join(sandbox.dir, 'fixtures/setuid'))
    fs.chmodSync(path.join(sandbox.dir, 'fixtures/setuid'), 0o4755)
    expect(sandbox.capture().code).toBe(0)
    const plan = sandbox.plan()
    expect(plan['test/plain.test.ts']?.action).toBe('skip')
    for (const file of ['test/direct.test.ts', 'test/nested.test.ts']) {
      expect(plan[file]?.reason, file).toBe('blocked-flag')
      expect(plan[file]?.details[0], file).toMatch(/spawn \(.*fixtures\/setuid\)$/)
    }
  })
})
