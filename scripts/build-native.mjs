#!/usr/bin/env node
// Builds the child-process tracer (packages/capture/native/trace.c) next to the capture package's
// compiled code. Tracing is Linux x64 only; elsewhere, or without a C compiler, nothing is built
// and child processes stay unobserved (a test that starts one always runs).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'packages/capture/native/trace.c')
const output = path.join(root, 'packages/capture/dist/native/libveyrum-trace.so')

if (process.platform !== 'linux' || process.arch !== 'x64') {
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
