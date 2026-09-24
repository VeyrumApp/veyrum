import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Test programs child-process tracing handles with ptrace (packages/capture/native/exec.c): a
 * statically linked C program and a Go program. Each is built once per source under the
 * repository's .sandbox directory; null when the toolchain is missing.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const cache = path.join(here, '../../.sandbox/programs')

function build(
  name: string,
  source: string,
  command: (output: string) => [string, string[], NodeJS.ProcessEnv?],
): string | null {
  const text = fs.readFileSync(source)
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
  const output = path.join(cache, `${name}-${hash}`)
  if (fs.existsSync(output)) return output
  fs.mkdirSync(cache, { recursive: true })
  // Built under a temporary name: test files build concurrently.
  const temporary = `${output}.${process.pid}`
  const [file, args, env] = command(temporary)
  const result = spawnSync(file, args, {
    cwd: path.dirname(source),
    env: env ?? process.env,
    stdio: 'ignore',
  })
  if (result.status !== 0 || !fs.existsSync(temporary)) {
    fs.rmSync(temporary, { force: true })
    return null
  }
  fs.renameSync(temporary, output)
  return output
}

/** The statically linked C program (programs/tool.c). */
export function staticTool(): string | null {
  return build('tool', path.join(here, 'programs/tool.c'), (output) => [
    process.env.CC ?? 'cc',
    ['-static', '-O2', '-pthread', '-o', output, 'tool.c'],
  ])
}

/** The Go program (programs/tool.go), or null without a Go toolchain. */
export function goTool(): string | null {
  return build('go-tool', path.join(here, 'programs/tool.go'), (output) => [
    'go',
    ['build', '-o', output, 'tool.go'],
    {
      ...process.env,
      CGO_ENABLED: '0',
      GO111MODULE: 'off',
      GOCACHE: process.env.GOCACHE ?? path.join(os.tmpdir(), 'veyrum-go-cache'),
    },
  ])
}

/** Copies a built program into a sandbox, executable. */
export function install(program: string, dir: string, rel: string): void {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.copyFileSync(program, file)
  fs.chmodSync(file, 0o755)
}
