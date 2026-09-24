import fs from 'node:fs'
import { afterEach, describe, expect, test } from 'vitest'
import { Sandbox } from '../../../test/support/sandbox.ts'

let sandbox: Sandbox | undefined
let link: string | undefined
afterEach(() => {
  if (link) fs.rmSync(link, { force: true })
  link = undefined
  sandbox?.dispose()
})

/**
 * A project reached by another spelling of its path: through a symbolic link here, or on Windows by
 * a short (8.3) name such as the runner's temporary directory. Runners resolve the files they run
 * to their real paths; Veyrum resolves the root the same way.
 */
describe.each(['vitest', 'jest'] as const)('a root reached through a symbolic link (%s)', (runner) => {
  test('is the same project: its files are reused', () => {
    const ext = runner === 'jest' ? 'js' : 'ts'
    sandbox = new Sandbox('linked-root', { runner })
      .write('src/math.js', 'function add(a, b) { return a + b }\nmodule.exports = { add }\n')
      .write(
        `test/add.test.${ext}`,
        runner === 'jest'
          ? "const { add } = require('../src/math')\ntest('add', () => expect(add(1, 2)).toBe(3))\n"
          : "import { expect, test } from 'vitest'\nimport { add } from '../src/math.js'\ntest('add', () => expect(add(1, 2)).toBe(3))\n",
      )
    link = `${sandbox.dir}-link`
    // Junctions: plain symbolic links need administrator rights on Windows.
    fs.symlinkSync(sandbox.dir, link, 'junction')
    const run = (...args: string[]) => sandbox!.raw(['run', '--root', link!, ...args])
    expect(run().output).toContain('1 test files, ran 1, reused evidence for 0')
    expect(run().output).toContain('1 test files, ran 0, reused evidence for 1')
    sandbox.edit('src/math.js', 'a + b', 'b + a')
    expect(run(`${link}/test/add.test.${ext}`).output).toContain('1 test files, ran 1, reused evidence for 0')
  })
})
