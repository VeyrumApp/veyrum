import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { nativeTools } from '../src/trace.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyrum-native-'))
  dirs.push(dir)
  return dir
}

/** A built package's native directory, with the launcher's mode as a package manager left it. */
function packaged(mode: number): { library: string; launcher: string } {
  const dir = tempDir()
  const library = path.join(dir, 'libveyrum-trace.so')
  const launcher = path.join(dir, 'veyrum-exec')
  fs.writeFileSync(library, 'library')
  fs.writeFileSync(launcher, 'launcher')
  fs.chmodSync(launcher, mode)
  return { library, launcher }
}

test.skipIf(process.platform === 'win32')('an executable launcher is used where it is', () => {
  const built = packaged(0o755)
  expect(nativeTools(tempDir(), built.library, built.launcher)).toEqual(built)
})

test.skipIf(process.platform === 'win32')(
  'a launcher packed without its executable bit is copied, with the library, and made executable',
  () => {
    const built = packaged(0o644)
    const run = tempDir()
    const tools = nativeTools(run, built.library, built.launcher)
    expect(path.dirname(tools.launcher!)).toBe(path.dirname(tools.library))
    expect(path.dirname(tools.launcher!).startsWith(run)).toBe(true)
    expect(fs.statSync(tools.launcher!).mode & 0o111).not.toBe(0)
    expect(fs.readFileSync(tools.library, 'utf8')).toBe('library')
    expect(fs.readFileSync(tools.launcher!, 'utf8')).toBe('launcher')
  },
)

test('without a launcher, there is none', () => {
  const built = packaged(0o644)
  fs.rmSync(built.launcher)
  expect(nativeTools(tempDir(), built.library, built.launcher)).toEqual({
    library: built.library,
    launcher: null,
  })
})
