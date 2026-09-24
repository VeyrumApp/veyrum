#!/usr/bin/env node
// Builds the child-process tracer next to the capture package's compiled code, in
// native/<platform>-<arch>/ (NATIVE_DIR in packages/capture/src/trace.ts). On Linux x64 and arm64:
// packages/capture/native/trace.c, and exec.c for programs it cannot follow. On macOS:
// trace-darwin.c, a universal library (arm64e included, for Apple's own programs), and its
// launcher, launch-darwin.c. These are TRACED_PLATFORMS in trace.ts; elsewhere, or without a C
// compiler, nothing is built and child processes stay unobserved (a test that starts one always
// runs, unless it is a Node program capture's own hooks follow).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nativeDir = path.join(root, 'packages/capture/dist/native', `${process.platform}-${process.arch}`)
const traced = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']

if (!traced.includes(`${process.platform}-${process.arch}`)) {
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
fs.mkdirSync(nativeDir, { recursive: true })

/** Compiles into `output` under a temporary name, so a failed build leaves nothing behind. */
function compile(output, args, stdio = 'inherit') {
  const temporary = `${output}.${process.pid}`
  try {
    execFileSync(cc, [...args, '-o', temporary], { stdio })
    fs.renameSync(temporary, output)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

const warnings = ['-O2', '-Wall', '-Wextra', '-Werror']

if (process.platform === 'darwin') {
  // Every architecture a program can run as here: Apple's own programs are arm64e on Apple
  // silicon (their shadow copies load that slice), and x86_64 programs run under Rosetta. Built
  // for the oldest macOS Node 22 runs on, so a published build loads everywhere.
  const target = '-mmacosx-version-min=11.0'
  compile(path.join(nativeDir, 'libveyrum-trace.dylib'), [
    '-dynamiclib',
    ...['-arch', 'x86_64', '-arch', 'arm64', '-arch', 'arm64e'],
    target,
    ...warnings,
    '-Wno-deprecated-declarations',
    path.join(root, 'packages/capture/native/trace-darwin.c'),
  ])
  compile(path.join(nativeDir, 'veyrum-exec'), [
    ...['-arch', 'x86_64', '-arch', 'arm64'],
    target,
    ...warnings,
    path.join(root, 'packages/capture/native/launch-darwin.c'),
  ])
  process.exit(0)
}

compile(path.join(nativeDir, 'libveyrum-trace.so'), [
  '-shared',
  '-fPIC',
  ...warnings,
  // Fortified wrappers would replace the functions this library defines.
  '-U_FORTIFY_SOURCE',
  '-D_FORTIFY_SOURCE=0',
  '-fvisibility=hidden',
  path.join(root, 'packages/capture/native/trace.c'),
  '-ldl',
])

// The launcher for programs the library cannot follow (packages/capture/native/exec.c). Linked
// statically, so the library is never preloaded into it; without a static C library it is not
// built, and those programs stay untraceable.
const launcher = path.join(nativeDir, 'veyrum-exec')
try {
  compile(
    launcher,
    ['-static', ...warnings, path.join(root, 'packages/capture/native/exec.c')],
    ['ignore', 'ignore', 'pipe'],
  )
} catch (error) {
  fs.rmSync(launcher, { force: true })
  const detail = String(error.stderr ?? error.message)
    .trim()
    .split('\n')
    .slice(0, 5)
    .join('\n')
  console.log(`build-native: veyrum-exec was not built; static and Go programs stay untraceable\n${detail}`)
}
