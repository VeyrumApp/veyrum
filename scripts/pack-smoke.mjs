#!/usr/bin/env node
/**
 * Installs the packed packages into fresh Vitest and Jest projects, the way a user installs them
 * from npm, and runs the edit cycle: record, reuse everything, edit one function, rerun only the
 * file that executed it. Run after `pnpm build`.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'veyrum-pack-'))
const packDir = path.join(work, 'pack')
const PACKAGES = ['core', 'capture', 'vitest', 'jest', 'node-test', 'cli']

/**
 * Runner versions to check: the versions this repository develops against, or the ones given as
 * SMOKE_VITEST and SMOKE_JEST (set only one to check only that runner).
 */
const devVersion = (pkg, dep) =>
  JSON.parse(fs.readFileSync(path.join(repo, 'packages', pkg, 'package.json'), 'utf8')).devDependencies[dep]
const pinned = process.env.SMOKE_VITEST || process.env.SMOKE_JEST
const vitestVersion = pinned ? process.env.SMOKE_VITEST : devVersion('vitest', 'vitest')
const jestVersion = pinned ? process.env.SMOKE_JEST : devVersion('jest', '@jest/core')

// On Windows, pnpm and package binaries are .cmd shims, which only a shell runs: they get one
// quoted command line.
const shell = process.platform === 'win32'
const commandLine = (command, args) =>
  [command, ...args].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ')
const spawn = (command, args, options) =>
  shell ? spawnSync(commandLine(command, args), { ...options, shell }) : spawnSync(command, args, options)

function run(command, args, cwd) {
  const result = spawn(command, args, { cwd, encoding: 'utf8', env: { ...process.env, CI: 'true' } })
  const output = `${result.stdout}${result.stderr}`
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${cwd}:\n${output}`)
  return output
}

function expectMatch(output, pattern, step) {
  if (!pattern.test(output)) throw new Error(`${step}: expected ${pattern} in:\n${output}`)
}

function tarball(name) {
  const file = fs.readdirSync(packDir).find((f) => f.startsWith(`${name}-`) && f.endsWith('.tgz'))
  if (!file) throw new Error(`no tarball for ${name}`)
  return `file:${path.join(packDir, file)}`
}

function project(name, devDependencies, files) {
  const dir = path.join(work, name)
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), content)
  }
  const pkg = {
    name,
    private: true,
    ...(name !== 'jest' ? { type: 'module' } : {}),
    ...(name === 'node-test' ? { scripts: { test: 'node --test' } } : {}),
  }
  pkg.devDependencies = { ...devDependencies, veyrum: tarball('veyrum') }
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  // Unpublished internal packages resolve to the tarballs too.
  const overrides = ['core', 'capture', 'vitest', 'jest', 'node-test'].map(
    (p) => `  '@veyrum/${p}': '${tarball(`veyrum-${p}`)}'`,
  )
  // Optional native helpers (Jest's, and esbuild for Vite 7) need no install scripts.
  const allowBuilds = "allowBuilds:\n  '@parcel/watcher': false\n  unrs-resolver: false\n  esbuild: false\n"
  fs.writeFileSync(
    path.join(dir, 'pnpm-workspace.yaml'),
    `overrides:\n${overrides.join('\n')}\n${allowBuilds}`,
  )
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.veyrum/\n')
  run('git', ['init', '-q'], dir)
  run('git', ['add', '-A'], dir)
  run('git', ['-c', 'user.email=smoke@veyrum.dev', '-c', 'user.name=smoke', 'commit', '-qm', 'init'], dir)
  run('pnpm', ['install', '--prefer-offline'], dir)
  return dir
}

function cycle(dir, source, testExt, files = 2) {
  const veyrum = path.join(dir, 'node_modules', '.bin', 'veyrum')
  const counts = (ran) => new RegExp(`${files} test files, ran ${ran}, reused evidence for ${files - ran}`)
  expectMatch(run(veyrum, ['run', '--quiet'], dir), counts(files), 'first run')
  // --explain: a failure then shows why each file ran.
  expectMatch(run(veyrum, ['run', '--quiet', '--explain'], dir), counts(0), 'unchanged')
  const file = path.join(dir, source)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('a * b', 'b * a'))
  const edited = run(veyrum, ['run', '--quiet', '--explain'], dir)
  expectMatch(edited, new RegExp(`run\\s+test/mul\\.test\\.${testExt}`), 'after edit')
  expectMatch(edited, counts(1), 'after edit')
  return (step, expectedFile) => {
    const out = run(veyrum, ['run', '--quiet', '--explain'], dir)
    expectMatch(out, new RegExp(`run\\s+${expectedFile.replaceAll('.', '\\.')}`), step)
    expectMatch(out, counts(1), step)
  }
}

/**
 * On Linux, a statically linked program: child-process tracing runs it under ptrace through
 * veyrum-exec, which must work from an install (package managers drop the executable bit). Null
 * where it cannot be built.
 */
function staticProgram(dir) {
  if (process.platform !== 'linux') return null
  const source = path.join(dir, 'fixtures', 'show.c')
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(
    source,
    '#include <stdio.h>\nint main(int argc, char **argv) {\n  FILE *f = fopen(argv[1], "r");\n  int c;\n  while (f && (c = fgetc(f)) != EOF) putchar(c);\n  return 0;\n}\n',
  )
  const cc = spawnSync(process.env.CC ?? 'cc', [
    '-static',
    '-O2',
    '-o',
    path.join(dir, 'fixtures', 'show'),
    source,
  ])
  if (cc.status !== 0) {
    // CI runners have a static C library: there, a missing one is a failure.
    if (process.env.CI) throw new Error(`cannot build a static program:\n${cc.stderr}`)
    return null
  }
  return path.join(dir, 'fixtures', 'show')
}

try {
  fs.mkdirSync(packDir)
  for (const p of PACKAGES)
    run('pnpm', ['pack', '--pack-destination', packDir], path.join(repo, 'packages', p))

  if (vitestVersion) {
    const vitestDir = project(
      'vitest',
      { vitest: vitestVersion },
      {
        'src/math.ts':
          'export const add = (a: number, b: number) => a + b\nexport const mul = (a: number, b: number) => a * b\n',
        'test/add.test.ts':
          "import { expect, test } from 'vitest'\nimport { add } from '../src/math'\ntest('add', () => expect(add(1, 2)).toBe(3))\n",
        'test/mul.test.ts':
          "import { expect, test } from 'vitest'\nimport { mul } from '../src/math'\ntest('mul', () => expect(mul(2, 3)).toBe(6))\n",
        'fixtures/data.txt': 'hello\n',
      },
    )
    const program = staticProgram(vitestDir)
    if (program) {
      fs.writeFileSync(
        path.join(vitestDir, 'test/show.test.ts'),
        "import { execFileSync } from 'node:child_process'\nimport { expect, test } from 'vitest'\ntest('show', () => expect(execFileSync('./fixtures/show', ['fixtures/data.txt']).toString()).toMatch(/^h/))\n",
      )
    }
    const next = cycle(vitestDir, 'src/math.ts', 'ts', program ? 3 : 2)
    if (program) {
      fs.writeFileSync(path.join(vitestDir, 'fixtures/data.txt'), 'hi\n')
      next('static program input', 'test/show.test.ts')
    }
    process.stdout.write(`vitest ${vitestVersion}: ok${program ? ' (with a static program)' : ''}\n`)
  }

  // Node's own runner needs nothing installed but Veyrum; checked with the full run only.
  if (!pinned) {
    const nodeDir = project(
      'node-test',
      {},
      {
        'src/math.js': 'export const add = (a, b) => a + b\nexport const mul = (a, b) => a * b\n',
        'test/add.test.js':
          "import test from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../src/math.js'\ntest('add', () => assert.equal(add(1, 2), 3))\n",
        'test/mul.test.js':
          "import test from 'node:test'\nimport assert from 'node:assert'\nimport { mul } from '../src/math.js'\ntest('mul', () => assert.equal(mul(2, 3), 6))\n",
      },
    )
    cycle(nodeDir, 'src/math.js', 'js')
    process.stdout.write('node:test: ok\n')
  }

  if (jestVersion) {
    const jestDir = project(
      'jest',
      { jest: jestVersion },
      {
        'src/math.js':
          'function add(a, b) { return a + b }\nfunction mul(a, b) { return a * b }\nmodule.exports = { add, mul }\n',
        'test/add.test.js':
          "const { add } = require('../src/math')\ntest('add', () => expect(add(1, 2)).toBe(3))\n",
        'test/mul.test.js':
          "const { mul } = require('../src/math')\ntest('mul', () => expect(mul(2, 3)).toBe(6))\n",
      },
    )
    cycle(jestDir, 'src/math.js', 'js')
    process.stdout.write(`jest ${jestVersion}: ok\n`)
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
