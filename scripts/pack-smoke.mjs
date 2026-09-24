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
const PACKAGES = ['core', 'capture', 'vitest', 'jest', 'cli']

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
  const pkg = { name, private: true, ...(name === 'vitest' ? { type: 'module' } : {}) }
  pkg.devDependencies = { ...devDependencies, veyrum: tarball('veyrum') }
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  // Unpublished internal packages resolve to the tarballs too.
  const overrides = ['core', 'capture', 'vitest', 'jest'].map(
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

function cycle(dir, source, testExt) {
  const veyrum = path.join(dir, 'node_modules', '.bin', 'veyrum')
  expectMatch(run(veyrum, ['run', '--quiet'], dir), /2 test files, ran 2, reused evidence for 0/, 'first run')
  expectMatch(run(veyrum, ['run', '--quiet'], dir), /2 test files, ran 0, reused evidence for 2/, 'unchanged')
  const file = path.join(dir, source)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('a * b', 'b * a'))
  const edited = run(veyrum, ['run', '--quiet', '--explain'], dir)
  expectMatch(edited, new RegExp(`run\\s+test/mul\\.test\\.${testExt}`), 'after edit')
  expectMatch(edited, /2 test files, ran 1, reused evidence for 1/, 'after edit')
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
      },
    )
    cycle(vitestDir, 'src/math.ts', 'ts')
    process.stdout.write(`vitest ${vitestVersion}: ok\n`)
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
