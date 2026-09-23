import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Sandbox } from '../../../test/support/sandbox.ts'

/** Non-code inputs: files, directories, environment, dependencies and configuration. */

let sandbox: Sandbox | undefined
afterEach(() => sandbox?.dispose())

const PLAIN_TEST = "import { expect, test } from 'vitest'\ntest('plain', () => expect(1).toBe(1))\n"

describe('files and directories', () => {
  test('a fixture read by a test is an input; unrelated fixtures are not', () => {
    sandbox = new Sandbox('fixture')
      .write('fixtures/data.json', '{"n": 1}\n')
      .write('fixtures/other.json', '{"n": 2}\n')
      .write(
        'test/fixture.test.ts',
        "import fs from 'node:fs'\nimport { expect, test } from 'vitest'\ntest('reads', () => expect(JSON.parse(fs.readFileSync('fixtures/data.json', 'utf8')).n).toBe(1))\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    sandbox.write('fixtures/other.json', '{"n": 3}\n')
    expect(sandbox.actions()).toEqual({ 'test/fixture.test.ts': 'skip', 'test/plain.test.ts': 'skip' })
    sandbox.write('fixtures/data.json', '{"n": 1, "extra": true}\n')
    expect(sandbox.actions()).toEqual({ 'test/fixture.test.ts': 'run', 'test/plain.test.ts': 'skip' })
  })

  test('a fixture read through fs/promises is an input', () => {
    sandbox = new Sandbox('fixture-promises')
      .write('fixtures/data.txt', 'hello\n')
      .write(
        'test/async.test.ts',
        "import { readFile } from 'node:fs/promises'\nimport { expect, test } from 'vitest'\ntest('reads', async () => expect(await readFile('fixtures/data.txt', 'utf8')).toContain('hello'))\n",
      )
    sandbox.capture()
    sandbox.write('fixtures/data.txt', 'hello world\n')
    expect(sandbox.actions()['test/async.test.ts']).toBe('run')
  })

  test('a directory listing is an input', () => {
    sandbox = new Sandbox('listing')
      .write('fixtures/cases/a.txt', 'a')
      .write(
        'test/cases.test.ts',
        "import fs from 'node:fs'\nimport { expect, test } from 'vitest'\ntest('cases', () => expect(fs.readdirSync('fixtures/cases').length).toBeGreaterThan(0))\n",
      )
    sandbox.capture()
    expect(sandbox.actions()['test/cases.test.ts']).toBe('skip')
    sandbox.write('fixtures/cases/b.txt', 'b')
    expect(sandbox.actions()['test/cases.test.ts']).toBe('run')
  })

  test('an existence check is an input', () => {
    sandbox = new Sandbox('exists').write(
      'test/exists.test.ts',
      "import fs from 'node:fs'\nimport { expect, test } from 'vitest'\ntest('exists', () => expect(fs.existsSync('fixtures/optional.txt')).toBe(false))\n",
    )
    sandbox.capture()
    sandbox.write('fixtures/optional.txt', 'now here')
    expect(sandbox.actions()['test/exists.test.ts']).toBe('run')
  })

  test('files a test writes and then reads are not inputs', () => {
    sandbox = new Sandbox('own-writes').write(
      'test/writes.test.ts',
      "import fs from 'node:fs'\nimport { expect, test } from 'vitest'\ntest('roundtrip', () => {\n  fs.mkdirSync('out', { recursive: true })\n  fs.writeFileSync('out/result.txt', String(Date.now()))\n  expect(fs.readFileSync('out/result.txt', 'utf8').length).toBeGreaterThan(0)\n})\n",
    )
    sandbox.capture()
    expect(sandbox.actions()['test/writes.test.ts']).toBe('skip')
  })

  test('a repository inside the OS temporary directory still records its fixture reads', () => {
    sandbox = new Sandbox('in-tmp', { base: fs.mkdtempSync(path.join(os.tmpdir(), 'veyrum-')) })
      .write('fixtures/data.json', '{"n": 1}\n')
      .write(
        'test/fixture.test.ts',
        "import fs from 'node:fs'\nimport { expect, test } from 'vitest'\ntest('reads', () => expect(fs.readFileSync('fixtures/data.json', 'utf8')).toContain('1'))\n",
      )
    sandbox.capture()
    sandbox.write('fixtures/data.json', '{"n": 2, "was": 1}\n')
    expect(sandbox.actions()['test/fixture.test.ts']).toBe('run')
  })

  test('a snapshot file is an input', () => {
    sandbox = new Sandbox('snapshot')
      .write(
        'test/snap.test.ts',
        "import { expect, test } from 'vitest'\ntest('snap', () => expect({ a: 1 }).toMatchSnapshot())\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    // The first run writes the snapshot, so it is not evidence; the second run is.
    sandbox.capture()
    expect(sandbox.actions()['test/snap.test.ts']).toBe('run')
    sandbox.capture()
    expect(sandbox.actions()).toEqual({ 'test/plain.test.ts': 'skip', 'test/snap.test.ts': 'skip' })
    sandbox.edit('test/__snapshots__/snap.test.ts.snap', '"a": 1', '"a": 2')
    expect(sandbox.actions()).toEqual({ 'test/plain.test.ts': 'skip', 'test/snap.test.ts': 'run' })
  })
})

describe('environment', () => {
  test('an environment variable read by a test is an input', () => {
    sandbox = new Sandbox('env')
      .write(
        'test/flag.test.ts',
        "import { expect, test } from 'vitest'\ntest('flag', () => expect(['on', 'off']).toContain(process.env.VEY_FEATURE_FLAG))\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture({ VEY_FEATURE_FLAG: 'on' })
    expect(sandbox.actions({ VEY_FEATURE_FLAG: 'on' })).toEqual({
      'test/flag.test.ts': 'skip',
      'test/plain.test.ts': 'skip',
    })
    expect(sandbox.actions({ VEY_FEATURE_FLAG: 'off' })).toEqual({
      'test/flag.test.ts': 'run',
      'test/plain.test.ts': 'skip',
    })
    expect(sandbox.actions({})).toEqual({ 'test/flag.test.ts': 'run', 'test/plain.test.ts': 'skip' })
  })

  test('an unset variable that becomes set invalidates', () => {
    sandbox = new Sandbox('env-unset').write(
      'test/unset.test.ts',
      "import { expect, test } from 'vitest'\ntest('unset', () => expect(process.env.VEY_OPTIONAL ?? 'default').toBe('default'))\n",
    )
    sandbox.capture()
    expect(sandbox.actions()['test/unset.test.ts']).toBe('skip')
    expect(sandbox.actions({ VEY_OPTIONAL: 'set' })['test/unset.test.ts']).toBe('run')
  })

  test('enumerating the environment is recorded but does not block reuse', () => {
    sandbox = new Sandbox('env-enum').write(
      'test/enum.test.ts',
      "import { expect, test } from 'vitest'\ntest('enum', () => expect(Object.keys(process.env).length).toBeGreaterThan(0))\n",
    )
    sandbox.capture()
    const decision = sandbox.plan()['test/enum.test.ts']
    expect(decision?.action).toBe('skip')
    expect(decision?.flagsRelied).toContain('env-enumerated')
  })
})

describe('dependencies and configuration', () => {
  function manifest(fields: Record<string, unknown>): string {
    return JSON.stringify({ name: 'manifest', private: true, type: 'module', ...fields }, null, 2)
  }

  test('a version range or script in package.json is not an input of the run; other fields are', () => {
    sandbox = new Sandbox('manifest')
      .write(
        'package.json',
        manifest({ scripts: { lint: 'eslint .' }, devDependencies: { eslint: '^10.8.0' } }),
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    sandbox.write(
      'package.json',
      manifest({ scripts: { lint: 'eslint . --fix' }, devDependencies: { eslint: '^10.10.0' } }),
    )
    expect(sandbox.actions()['test/plain.test.ts']).toBe('skip')
    sandbox.write(
      'package.json',
      manifest({
        scripts: { lint: 'eslint . --fix' },
        devDependencies: { eslint: '^10.10.0', prettier: '^3.0.0' },
      }),
    )
    expect(sandbox.actions()['test/plain.test.ts']).toBe('run')
    sandbox.capture()
    sandbox.write(
      'package.json',
      manifest({
        scripts: { lint: 'eslint . --fix' },
        devDependencies: { eslint: '^10.10.0', prettier: '^3.0.0' },
        imports: { '#src/*': './src/*' },
      }),
    )
    expect(sandbox.actions()['test/plain.test.ts']).toBe('run')
  })

  test('a test that imports package.json depends on all of it', () => {
    sandbox = new Sandbox('manifest-import')
      .write('package.json', manifest({ devDependencies: { eslint: '^10.8.0' } }))
      .write(
        'test/manifest.test.ts',
        "import { expect, test } from 'vitest'\nimport pkg from '../package.json'\ntest('deps', () => expect(Object.values(pkg.devDependencies)).toContain('^10.8.0'))\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    sandbox.write('package.json', manifest({ devDependencies: { eslint: '^10.10.0' } }))
    expect(sandbox.actions()).toEqual({ 'test/manifest.test.ts': 'run', 'test/plain.test.ts': 'skip' })
  })

  function depProject(name: string): Sandbox {
    sandbox = new Sandbox(name)
      .write(
        'node_modules/fake-dep/package.json',
        JSON.stringify({ name: 'fake-dep', version: '1.0.0', type: 'module', main: 'index.js' }),
      )
      .write('node_modules/fake-dep/index.js', 'export function answer() {\n  return 42\n}\n')
      .write('src/use.ts', "import { answer } from 'fake-dep'\nexport const value = answer()\n")
      .write(
        'test/dep.test.ts',
        "import { expect, test } from 'vitest'\nimport { value } from '../src/use'\ntest('dep', () => expect(value).toBe(42))\n",
      )
      .write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    return sandbox
  }

  test('a dependency file change reruns only the tests that loaded it', () => {
    const sb = depProject('dep-file')
    sb.edit('node_modules/fake-dep/index.js', 'return 42', 'return 43')
    expect(sb.actions()).toEqual({ 'test/dep.test.ts': 'run', 'test/plain.test.ts': 'skip' })
  })

  test('a dependency manifest change reruns the tests that loaded it', () => {
    const sb = depProject('dep-manifest')
    sb.edit('node_modules/fake-dep/package.json', '"1.0.0"', '"1.0.1"')
    expect(sb.actions()).toEqual({ 'test/dep.test.ts': 'run', 'test/plain.test.ts': 'skip' })
  })

  test('the project package.json is an input of every module below it', () => {
    sandbox = new Sandbox('manifest').write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    sandbox.edit('package.json', '"private": true', '"private": true,\n  "imports": { "#x": "./x.js" }')
    expect(sandbox.actions()['test/plain.test.ts']).toBe('run')
  })

  test('a Vitest config change reruns everything', () => {
    sandbox = new Sandbox('config').write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    sandbox.edit('vitest.config.ts', 'test: {}', 'test: { testTimeout: 7000 }')
    const decision = sandbox.plan()['test/plain.test.ts']
    expect(decision?.action).toBe('run')
    expect(decision?.details.join(' ')).toContain('vitest.config.ts')
  })

  test('a new or changed tsconfig reruns everything', () => {
    sandbox = new Sandbox('tsconfig').write('test/plain.test.ts', PLAIN_TEST)
    sandbox.capture()
    sandbox.write('tsconfig.json', '{ "compilerOptions": { "target": "es2022" } }\n')
    expect(sandbox.actions()['test/plain.test.ts']).toBe('run')
    sandbox.capture()
    expect(sandbox.actions()['test/plain.test.ts']).toBe('skip')
    sandbox.edit('tsconfig.json', 'es2022', 'es2020')
    expect(sandbox.actions()['test/plain.test.ts']).toBe('run')
  })
})
