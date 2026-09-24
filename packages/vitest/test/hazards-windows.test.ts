import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { Sandbox } from '../../../test/support/sandbox.ts'
import { TRACED_PLATFORMS } from '../../capture/src/trace.ts'

/**
 * Child processes on Windows: every program a test starts runs through veyrum-exec.exe, which
 * loads veyrum-trace.dll into it, and the DLL into everything it starts in turn. What they read,
 * list and check is an input of the test file like anything the test reads itself.
 */

let sandbox: Sandbox | undefined
afterEach(() => sandbox?.dispose())

const windows =
  process.platform === 'win32' && TRACED_PLATFORMS.includes(`${process.platform}-${process.arch}`)
const nativeDir = path.resolve(
  fileURLToPath(import.meta.url),
  `../../../capture/dist/native/${process.platform}-${process.arch}`,
)
/** A 32-bit program, which the 64-bit DLL cannot be loaded into. */
const cmd32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'SysWOW64', 'cmd.exe')

const spawnTest = (body: string): string =>
  `import { execFileSync, execSync, fork, spawn, spawnSync } from 'node:child_process'\nimport fs from 'node:fs'\nimport { expect, test } from 'vitest'\ntest('child', async () => {\n${body}\n}, 60_000)\n`
const plain = "import { expect, test } from 'vitest'\ntest('plain', () => expect(1).toBe(1))\n"

describe.runIf(windows)('child processes on Windows', () => {
  // Where tracing is built, both files are: without them every program would block reuse.
  test('the tracer and its launcher build here', () => {
    expect(fs.existsSync(path.join(nativeDir, 'veyrum-trace.dll'))).toBe(true)
    expect(fs.existsSync(path.join(nativeDir, 'veyrum-exec.exe'))).toBe(true)
  })

  test('what a program reads, lists and checks is an input of the file that started it', () => {
    sandbox = new Sandbox('win-read')
      .write('fixtures/x.txt', 'a')
      .write('fixtures/other.txt', 'o')
      .write('fixtures/dir/one', '1')
      .write(
        'test/child.test.ts',
        spawnTest(
          [
            String.raw`  expect(execSync('type fixtures\\x.txt').toString()).toMatch(/^[ab]$/)`,
            String.raw`  expect(execFileSync('cmd.exe', ['/d', '/c', 'dir /b fixtures\\dir']).toString()).toMatch(/one/)`,
            String.raw`  expect(execSync('if exist fixtures\\later (echo yes) else (echo no)').toString().trim()).toMatch(/^(yes|no)$/)`,
          ].join('\n'),
        ),
      )
      .write('test/plain.test.ts', plain)
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
  })

  test('what a Node child and the programs it starts read and load are inputs', () => {
    sandbox = new Sandbox('win-nested')
      .write('fixtures/x.txt', 'a')
      .write('fixtures/y.txt', 'b')
      .write('fixtures/lib.cjs', "module.exports = (f) => require('node:fs').readFileSync(f, 'utf8')\n")
      .write(
        'fixtures/child.cjs',
        String.raw`const read = require('./lib.cjs')
const { execSync } = require('node:child_process')
process.stdout.write(read('fixtures/x.txt') + execSync('type fixtures\\y.txt'))
`,
      )
      .write(
        'test/child.test.ts',
        spawnTest(
          "  expect(execFileSync(process.execPath, ['fixtures/child.cjs']).toString()).toMatch(/^..$/)",
        ),
      )
    sandbox.capture()
    expect(sandbox.actions()['test/child.test.ts']).toBe('skip')
    for (const [file, from, to] of [
      ['fixtures/x.txt', 'a', 'A'],
      ['fixtures/y.txt', 'b', 'B'],
      ['fixtures/lib.cjs', "'utf8'", "'utf-8'"],
    ] as const) {
      sandbox.edit(file, from, to)
      expect(sandbox.plan()['test/child.test.ts']?.details, file).toEqual([`${file} changed`])
      sandbox.capture()
    }
  })

  test('programs run as they would untraced: arguments, argv[0], exit codes, output and IPC', () => {
    sandbox = new Sandbox('win-behavior')
      .write(
        'fixtures/forked.cjs',
        "process.on('message', (m) => process.send(m + '!', () => process.exit(0)))\n",
      )
      .write(
        'test/child.test.ts',
        spawnTest(
          [
            // Arguments Node must quote, including an empty one and a trailing backslash.
            String.raw`  const args = ['a b', 'c"d', '', 'e\\', 'f\\"g']`,
            "  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1))); process.exit(3)', ...args])",
            '  expect([r.status, JSON.parse(r.stdout.toString())]).toEqual([3, args])',
            "  expect(spawnSync(process.execPath, ['-e', 'process.stdout.write(process.argv0)'], { argv0: 'named' }).stdout.toString()).toBe('named')",
            `  expect(execSync('echo "a b"').toString().trim()).toBe('"a b"')`,
            "  expect(execFileSync('cmd.exe', ['/d', '/c', 'echo %VEYRUM_WIN_VALUE%'], { env: { ...process.env, VEYRUM_WIN_VALUE: 'v' } }).toString().trim()).toBe('v')",
            "  let status = 0\n  try { execSync('exit /b 4', { stdio: 'ignore' }) } catch (e) { status = e.status }\n  expect(status).toBe(4)",
            "  const child = fork('fixtures/forked.cjs')\n  child.send('ping')\n  expect(await new Promise((r) => child.once('message', r))).toBe('ping!')\n  expect(await new Promise((r) => child.once('exit', r))).toBe(0)",
          ].join('\n'),
        ),
      )
    const result = sandbox.capture()
    expect(result.code, result.output).toBe(0)
    expect(sandbox.actions()['test/child.test.ts']).toBe('skip')
  })

  test('killing a started program ends it', () => {
    sandbox = new Sandbox('win-kill').write(
      'test/child.test.ts',
      spawnTest(
        [
          // The program would write a file after a while: killed at once, it never does.
          "  const child = spawn(process.execPath, ['-e', \"process.stdout.write('ready'); setTimeout(() => require('fs').writeFileSync('late.txt', ''), 3000)\"])",
          "  await new Promise((r) => child.stdout.once('data', r))",
          '  child.kill()',
          "  await new Promise((r) => child.once('exit', r))",
          '  await new Promise((r) => setTimeout(r, 4000))',
          "  expect(fs.existsSync('late.txt')).toBe(false)",
        ].join('\n'),
      ),
    )
    const result = sandbox.capture()
    expect(result.code, result.output).toBe(0)
  })

  test("the child's environment is an input", () => {
    sandbox = new Sandbox('win-env').write(
      'test/child.test.ts',
      spawnTest("  expect(execSync('echo %GREETING%').toString().trim()).toMatch(/^(hi|bye)$/)"),
    )
    sandbox.capture({ GREETING: 'hi' })
    expect(sandbox.actions({ GREETING: 'hi' })['test/child.test.ts']).toBe('skip')
    expect(sandbox.actions({ GREETING: 'bye' })['test/child.test.ts']).toBe('run')
  })

  test.runIf(fs.existsSync(cmd32))(
    'a 32-bit program, started directly or by a traced one, blocks reuse',
    () => {
      sandbox = new Sandbox('win-32bit')
        .write(
          'test/direct.test.ts',
          spawnTest(`  execFileSync(${JSON.stringify(cmd32)}, ['/d', '/c', 'exit 0'])`),
        )
        .write('test/nested.test.ts', spawnTest(`  execSync(${JSON.stringify(`"${cmd32}" /d /c exit 0`)})`))
      sandbox.capture()
      const plan = sandbox.plan()
      expect(plan['test/direct.test.ts']?.reason).toBe('blocked-flag')
      expect(plan['test/nested.test.ts']?.reason).toBe('blocked-flag')
      expect(plan['test/nested.test.ts']?.details[0]).toMatch(/SysWOW64/i)
    },
  )
})
