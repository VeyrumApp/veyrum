#!/usr/bin/env node
// Builds the child-process tracer (packages/capture/native/trace.c, and exec.c for programs it
// cannot follow) next to the capture package's compiled code. Tracing is built on Linux x64 and arm64 (TRACED_PLATFORMS in
// packages/capture/src/trace.ts); elsewhere, or without a C compiler, nothing is built and child
// processes stay unobserved (a test that starts one always runs).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'packages/capture/native/trace.c')
const nativeDir = path.join(root, 'packages/capture/dist/native', `${process.platform}-${process.arch}`)
const output = path.join(nativeDir, 'libveyrum-trace.so')

if (!['linux-x64', 'linux-arm64'].includes(`${process.platform}-${process.arch}`)) {
  console.log(`build-native: child-process tracing is not built on ${process.platform}-${process.arch}`)
  process.exit(0)
}
const cc = process.env.CC ?? 'cc'
try {
  execFileSync(cc, ['--version'], { stdio: 'ignore' })
} catch {
  console.log(`build-native: no C compiler (${cc}); child-process tracing is not built`)
  process.exit(0)
}
fs.mkdirSync(path.dirname(output), { recursive: true })
const temporary = `${output}.${process.pid}`
execFileSync(
  cc,
  [
    '-shared',
    '-fPIC',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    // Fortified wrappers would replace the functions this library defines.
    '-U_FORTIFY_SOURCE',
    '-D_FORTIFY_SOURCE=0',
    '-fvisibility=hidden',
    '-o',
    temporary,
    source,
    '-ldl',
  ],
  { stdio: 'inherit' },
)
fs.renameSync(temporary, output)

// The launcher for programs the library cannot follow (packages/capture/native/exec.c). Linked
// statically, so the library is never preloaded into it; without a static C library it is not
// built, and those programs stay untraceable.
const launcher = path.join(nativeDir, 'veyrum-exec')
const launcherTemporary = `${launcher}.${process.pid}`
try {
  execFileSync(
    cc,
    [
      '-static',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-o',
      launcherTemporary,
      path.join(root, 'packages/capture/native/exec.c'),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  fs.renameSync(launcherTemporary, launcher)
} catch (error) {
  fs.rmSync(launcherTemporary, { force: true })
  fs.rmSync(launcher, { force: true })
  const detail = String(error.stderr ?? error.message)
    .trim()
    .split('\n')
    .slice(0, 5)
    .join('\n')
  console.log(`build-native: veyrum-exec was not built; static and Go programs stay untraceable\n${detail}`)
}
