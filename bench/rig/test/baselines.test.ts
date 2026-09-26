import { afterEach, expect, test } from 'vitest'
import { Sandbox } from '../../../test/support/sandbox.ts'

let sandbox: Sandbox | undefined
afterEach(() => sandbox?.dispose())

/** The file-closure baseline: Veyrum's own plan with modules compared whole (see replay.ts). */
const wholeModules = (s: Sandbox): Record<string, 'run' | 'skip'> => s.actions({ VEYRUM_WHOLE_MODULES: '1' })

test('file-closure identity reuses what Veyrum would, comparing modules whole', () => {
  sandbox = new Sandbox('rig-file-closure')
    .write('src/math.ts', 'export const add = (a: number, b: number) => a + b\n')
    .write(
      'test/add.test.ts',
      "import { expect, test } from 'vitest'\nimport { add } from '../src/math.ts'\ntest('adds', () => expect(add(1, 2)).toBe(3))\n",
    )
    .write(
      'test/plain.test.ts',
      "import { expect, test } from 'vitest'\ntest('plain', () => expect(1).toBe(1))\n",
    )
  sandbox.capture()
  expect(wholeModules(sandbox)).toEqual({ 'test/add.test.ts': 'skip', 'test/plain.test.ts': 'skip' })
  // A comment is invisible to function fingerprints but changes a module compared whole.
  sandbox.write('src/math.ts', '// a comment\nexport const add = (a: number, b: number) => a + b\n')
  expect(sandbox.actions()).toEqual({ 'test/add.test.ts': 'skip', 'test/plain.test.ts': 'skip' })
  expect(wholeModules(sandbox)).toEqual({ 'test/add.test.ts': 'run', 'test/plain.test.ts': 'skip' })
})
