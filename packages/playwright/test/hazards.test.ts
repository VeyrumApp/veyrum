import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { PLAYWRIGHT_BROWSERS, Sandbox } from '../../../test/support/sandbox.ts'

/**
 * End-to-end scenarios for the Playwright adapter, through the real CLI, Playwright, Chromium and
 * an app server. Each records evidence, changes something, and asserts which files the plan runs.
 *
 * Needs Chromium in the repository's browser cache (.sandbox/ms-playwright, see the CI workflow);
 * without it the suite is skipped, except on Linux in CI, where it must run.
 */

/** Whether the Chromium build this Playwright drives is installed in the scenarios' browser cache. */
function chromiumInstalled(): boolean {
  try {
    const require = createRequire(import.meta.url)
    const playwright = require.resolve('@playwright/test/package.json')
    const core = createRequire(createRequire(playwright).resolve('playwright/package.json')).resolve(
      'playwright-core/package.json',
    )
    const { browsers } = JSON.parse(
      fs.readFileSync(path.join(path.dirname(core), 'browsers.json'), 'utf8'),
    ) as {
      browsers: { name: string; revision: string }[]
    }
    const shell = browsers.find((b) => b.name === 'chromium-headless-shell')
    return (
      shell !== undefined &&
      fs.existsSync(
        path.join(PLAYWRIGHT_BROWSERS, `chromium_headless_shell-${shell.revision}`, 'INSTALLATION_COMPLETE'),
      )
    )
  } catch {
    return false
  }
}

const required = process.env.CI !== undefined && process.platform === 'linux'
const available = chromiumInstalled()
if (required && !available)
  throw new Error(`Chromium is not installed in ${PLAYWRIGHT_BROWSERS}; install it as the CI workflow does`)
const python = spawnSync('python3', ['--version']).status === 0

let sandbox: Sandbox | undefined
afterEach(() => sandbox?.dispose())

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

/** A static file server with one API route, as a Node program. */
const SERVER = `import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const root = path.join(import.meta.dirname, 'public')
http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/greeting') {
      const { text } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'data', 'greeting.json'), 'utf8'))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ text: text.toUpperCase() }))
      return
    }
    const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname)
    fs.readFile(file, (error, data) => {
      if (error) {
        res.statusCode = 404
        res.end()
        return
      }
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'text/html')
      res.end(data)
    })
  })
  .listen(Number(process.env.PORT), '127.0.0.1')
`

const INDEX = `<!doctype html>
<html>
  <body>
    <button id="add">add</button>
    <button id="mul">mul</button>
    <output id="out"></output>
    <script src="/app.js"></script>
  </body>
</html>
`

const APP = `function add(a, b) {
  return a + b
}
function mul(a, b) {
  return a * b
}
function show(value) {
  document.getElementById('out').textContent = String(value)
}
document.getElementById('add').onclick = () => show(add(2, 3))
document.getElementById('mul').onclick = () => show(mul(2, 3))
fetch('/api/greeting')
  .then((response) => response.json())
  .then((greeting) => {
    document.title = greeting.text
  })
`

const spec = (name: string, button: string, expected: string): string =>
  `import { expect, test } from '@playwright/test'

test('${name}', async ({ page }) => {
  await page.goto('/')
  await page.click('#${button}')
  await expect(page.locator('#out')).toHaveText('${expected}')
})
`

function config(port: number, command = 'node server.js'): string {
  return `import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:${port}', launchOptions: { args: ['--mute-audio'] } },
  webServer: { command: ${JSON.stringify(command)}, url: 'http://127.0.0.1:${port}/', env: { PORT: '${port}' } },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
`
}

/** The app with two specs, each clicking a button that runs its own function of app.js. */
async function project(name: string): Promise<Sandbox> {
  const port = await freePort()
  sandbox = new Sandbox(name, { runner: 'playwright' })
  return sandbox
    .write('playwright.config.js', config(port))
    .write('server.js', SERVER)
    .write('public/index.html', INDEX)
    .write('public/app.js', APP)
    .write('data/greeting.json', '{ "text": "hello" }\n')
    .write('e2e/add.spec.js', spec('adds', 'add', '5'))
    .write('e2e/mul.spec.js', spec('multiplies', 'mul', '6'))
}

/**
 * The app with two specs that import one module of the test process, src/math, each calling its
 * own function of it: as an ES module, in TypeScript, or as CommonJS in a package that is not a
 * module.
 */
async function mathProject(name: string, kind: 'esm' | 'ts' | 'cjs'): Promise<Sandbox> {
  const s = await project(name)
  const ext = kind === 'ts' ? 'ts' : 'js'
  const typed = kind === 'ts' ? ': number' : ''
  const functions = [
    ['add', 'a + b'],
    ['mul', 'a * b'],
  ].map(([fn, body]) => `function ${fn}(a${typed}, b${typed})${typed} {\n  return ${body}\n}\n`)
  if (kind === 'cjs') {
    // The package is no longer a module: the configuration becomes CommonJS, and the app server,
    // an ES module, an .mjs file.
    const commonjsConfig = s
      .read('playwright.config.js')
      .replace(
        "import { defineConfig } from '@playwright/test'",
        "const { defineConfig } = require('@playwright/test')",
      )
      .replace('export default', 'module.exports =')
      .replace('node server.js', 'node server.mjs')
    s.write('package.json', JSON.stringify({ name, private: true }, null, 2))
      .write('playwright.config.js', commonjsConfig)
      .remove('server.js')
      .write('server.mjs', SERVER)
      .write('src/math.js', `${functions.join('')}module.exports = { add, mul }\n`)
  } else {
    s.write(`src/math.${ext}`, functions.map((f) => `export ${f}`).join(''))
  }
  s.remove('e2e/add.spec.js').remove('e2e/mul.spec.js')
  for (const [fn, title, expected] of [
    ['add', 'adds', 5],
    ['mul', 'multiplies', 6],
  ] as const) {
    const imports =
      kind === 'cjs'
        ? `const { expect, test } = require('@playwright/test')\nconst { ${fn} } = require('../src/math.js')\n`
        : `import { expect, test } from '@playwright/test'\nimport { ${fn} } from '../src/math${kind === 'ts' ? '' : '.js'}'\n`
    s.write(
      `e2e/${fn}.spec.${ext}`,
      `${imports}\ntest('${title}', async ({ baseURL }) => {\n  expect(baseURL).toBeTruthy()\n  expect(${fn}(2, 3)).toBe(${expected})\n})\n`,
    )
  }
  return s
}

describe.skipIf(!available)('playwright', () => {
  test('nothing changed reuses every file; a comment in client code changes nothing', async () => {
    const s = await project('pw-unchanged')
    expect(s.capture().code).toBe(0)
    expect(s.actions()).toEqual({ 'e2e/add.spec.js': 'skip', 'e2e/mul.spec.js': 'skip' })
    s.edit('public/app.js', 'function mul', '// multiplies\nfunction mul')
    expect(s.actions()).toEqual({ 'e2e/add.spec.js': 'skip', 'e2e/mul.spec.js': 'skip' })
  })

  test('editing a client function reruns only the file whose page ran it', async () => {
    const s = await project('pw-client')
    s.capture()
    s.edit('public/app.js', 'return a * b', 'return b * a')
    expect(s.actions()).toEqual({ 'e2e/add.spec.js': 'skip', 'e2e/mul.spec.js': 'run' })
    expect(s.plan()['e2e/mul.spec.js']?.details).toEqual(['public/app.js: mul changed'])
    // Running the affected file records it again; then everything is reusable.
    const run = s.cli(['run'])
    expect(run.code).toBe(0)
    expect(run.outcomes.map((o) => o.check.path)).toEqual(['e2e/mul.spec.js'])
    expect(s.actions()).toEqual({ 'e2e/add.spec.js': 'skip', 'e2e/mul.spec.js': 'skip' })
    // Code both pages ran reruns both.
    s.edit('public/app.js', 'String(value)', 'String(value) + ""')
    expect(s.actions()).toEqual({ 'e2e/add.spec.js': 'run', 'e2e/mul.spec.js': 'run' })
  })

  test('a page the browser received as a document is compared whole', async () => {
    const s = await project('pw-document')
    s.capture()
    s.edit('public/index.html', '<output', '<p>hi</p><output')
    expect(s.actions()).toEqual({ 'e2e/add.spec.js': 'run', 'e2e/mul.spec.js': 'run' })
    expect(s.plan()['e2e/add.spec.js']?.details).toEqual(['public/index.html changed'])
  })

  test('editing server code, or data the server reads, reruns every file that talked to it', async () => {
    const s = (await project('pw-server')).write(
      'e2e/local.spec.js',
      "import { expect, test } from '@playwright/test'\ntest('computes', () => expect(1 + 1).toBe(2))\n",
    )
    s.capture()
    const all = (action: 'run' | 'skip') => ({
      'e2e/add.spec.js': action,
      'e2e/local.spec.js': 'skip',
      'e2e/mul.spec.js': action,
    })
    expect(s.actions()).toEqual(all('skip'))
    s.edit('server.js', 'text.toUpperCase()', 'text.toLowerCase()')
    expect(s.actions()).toEqual(all('run'))
    expect(s.plan()['e2e/add.spec.js']?.details).toEqual(['server.js changed'])
    s.edit('server.js', 'text.toLowerCase()', 'text.toUpperCase()')
    // No browser received this file as it is: the server computes from it.
    s.write('data/greeting.json', '{ "text": "hi" }\n')
    expect(s.actions()).toEqual(all('run'))
    expect(s.plan()['e2e/mul.spec.js']?.details).toEqual(['data/greeting.json changed'])
  })

  test('a program global setup starts is an input of every file', async () => {
    const s = (await project('pw-setup'))
      .write('seed.js', "import fs from 'node:fs'\nfs.readFileSync('seed/data.json', 'utf8')\n")
      .write('seed/data.json', '{}\n')
      .write(
        'global-setup.js',
        "import { execFileSync } from 'node:child_process'\nexport default () => {\n  execFileSync(process.execPath, ['seed.js'])\n}\n",
      )
      .write(
        'e2e/local.spec.js',
        "import { expect, test } from '@playwright/test'\ntest('computes', () => expect(1 + 1).toBe(2))\n",
      )
      .edit('playwright.config.js', "testDir: 'e2e',", "testDir: 'e2e',\n  globalSetup: './global-setup.js',")
    s.capture()
    const all = (action: 'run' | 'skip') => ({
      'e2e/add.spec.js': action,
      'e2e/local.spec.js': action,
      'e2e/mul.spec.js': action,
    })
    expect(s.actions()).toEqual(all('skip'))
    s.write('seed/data.json', '{ "users": 1 }\n')
    expect(s.actions()).toEqual(all('run'))
    expect(s.plan()['e2e/local.spec.js']?.details).toEqual(['seed/data.json changed'])
  })

  test('a fixture a spec reads is an input of that spec only', async () => {
    const s = (await project('pw-fixture')).write('fixtures/expected.json', '{ "sum": "5" }\n').write(
      'e2e/add.spec.js',
      `import fs from 'node:fs'
import { expect, test } from '@playwright/test'

const expected = JSON.parse(fs.readFileSync('fixtures/expected.json', 'utf8'))
test('adds', async ({ page }) => {
  await page.goto('/')
  await page.click('#add')
  await expect(page.locator('#out')).toHaveText(expected.sum)
})
`,
    )
    s.capture()
    expect(s.actions()).toEqual({ 'e2e/add.spec.js': 'skip', 'e2e/mul.spec.js': 'skip' })
    s.write('fixtures/expected.json', '{ "sum": "5", "note": "same" }\n')
    expect(s.actions()).toEqual({ 'e2e/add.spec.js': 'run', 'e2e/mul.spec.js': 'skip' })
    expect(s.plan()['e2e/add.spec.js']?.details).toEqual(['fixtures/expected.json changed'])
  })

  test('a server a test starts itself is an input of that test', async () => {
    const port = await freePort()
    const s = (await project('pw-own-server'))
      .write(
        'mock.js',
        `import http from 'node:http'\nhttp.createServer((req, res) => res.end('<p id="out">mocked</p>')).listen(${port}, '127.0.0.1', () => console.log('ready'))\n`,
      )
      .write(
        'e2e/mock.spec.js',
        `import { spawn } from 'node:child_process'
import { expect, test } from '@playwright/test'

test('talks to its own server', async ({ page }) => {
  const server = spawn(process.execPath, ['mock.js'], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((resolve) => server.stdout.once('data', resolve))
  try {
    await page.goto('http://127.0.0.1:${port}/')
    await expect(page.locator('#out')).toHaveText('mocked')
  } finally {
    server.kill()
  }
})
`,
      )
    s.capture()
    expect(s.actions()).toEqual({
      'e2e/add.spec.js': 'skip',
      'e2e/mock.spec.js': 'skip',
      'e2e/mul.spec.js': 'skip',
    })
    s.edit('mock.js', "res.end('<p", 'res.end(\'<p class="x"')
    expect(s.actions()).toEqual({
      'e2e/add.spec.js': 'skip',
      'e2e/mock.spec.js': 'run',
      'e2e/mul.spec.js': 'skip',
    })
  })

  test('editing a function a spec imports reruns only the spec that ran it', async () => {
    const mathSpec = (name: string, fn: string, expected: number): string =>
      `import { expect, test } from '@playwright/test'
import { ${fn} } from '../src/math.js'

test('${name}', async ({ baseURL }) => {
  expect(baseURL).toBeTruthy()
  expect(${fn}(2, 3)).toBe(${expected})
})
`
    const s = (await project('pw-module'))
      .write(
        'src/math.js',
        'export function add(a, b) {\n  return a + b\n}\nexport function mul(a, b) {\n  return a * b\n}\n',
      )
      .write('e2e/add.spec.js', mathSpec('adds', 'add', 5))
      .write('e2e/mul.spec.js', mathSpec('multiplies', 'mul', 6))
    expect(s.capture().code).toBe(0)
    s.edit('src/math.js', 'return a * b', 'return b * a')
    expect(s.actions()).toEqual({ 'e2e/add.spec.js': 'skip', 'e2e/mul.spec.js': 'run' })
  })

  test('a TypeScript module specs import: a comment or formatting changes nothing, a function only its spec', async () => {
    const s = await mathProject('pw-module-ts', 'ts')
    s.capture()
    s.edit('src/math.ts', 'export function mul', '// Multiplies.\nexport   function   mul')
    s.edit('src/math.ts', 'return a + b', 'return (a + b);')
    expect(s.actions()).toEqual({ 'e2e/add.spec.ts': 'skip', 'e2e/mul.spec.ts': 'skip' })
    // Playwright reads a test callback's source only for its parameter list (the fixtures it uses),
    // so a comment in a spec changes nothing either.
    s.edit('e2e/add.spec.ts', "test('adds'", "// Adds two numbers.\ntest('adds'")
    expect(s.actions()).toEqual({ 'e2e/add.spec.ts': 'skip', 'e2e/mul.spec.ts': 'skip' })
    // Types are erased: the code that runs is the same.
    s.edit('src/math.ts', 'mul(a: number, b: number): number', 'mul(a: number, b: number): unknown')
    expect(s.actions()).toEqual({ 'e2e/add.spec.ts': 'skip', 'e2e/mul.spec.ts': 'skip' })
    s.edit('src/math.ts', 'return a * b', 'return b * a')
    expect(s.actions()).toEqual({ 'e2e/add.spec.ts': 'skip', 'e2e/mul.spec.ts': 'run' })
    expect(s.plan()['e2e/mul.spec.ts']?.details).toEqual(['src/math.ts: mul changed'])
  })

  test('a CommonJS module specs require: editing a function reruns only the spec that ran it', async () => {
    const s = await mathProject('pw-module-cjs', 'cjs')
    s.capture()
    s.edit('src/math.js', 'return a * b', 'return b * a')
    expect(s.actions()).toEqual({ 'e2e/add.spec.js': 'skip', 'e2e/mul.spec.js': 'run' })
    expect(s.plan()['e2e/mul.spec.js']?.details).toEqual(['src/math.js: mul changed'])
  })

  test('a module whose compiled code Veyrum cannot reproduce is compared whole', async () => {
    // Playwright leaves files the configuration marks as external uncompiled: what ran is not what
    // its transform produces, so the module is compared by its source.
    const s = (await mathProject('pw-module-external', 'esm')).edit(
      'playwright.config.js',
      "testDir: 'e2e',",
      "testDir: 'e2e',\n  build: { external: ['**/src/math.js'] },",
    )
    s.capture()
    expect(s.actions()).toEqual({ 'e2e/add.spec.js': 'skip', 'e2e/mul.spec.js': 'skip' })
    s.edit('src/math.js', 'return a * b', 'return b * a')
    expect(s.actions()).toEqual({ 'e2e/add.spec.js': 'run', 'e2e/mul.spec.js': 'run' })
    expect(s.plan()['e2e/add.spec.js']?.details).toEqual([expect.stringMatching(/^src\/math\.js changed/)])
  })

  test('when Veyrum fails before the run, Playwright runs every file on its own', async () => {
    const s = await project('pw-fail-open')
    const result = s.raw(['run'], { VEYRUM_FAULT: 'before-run' })
    expect(result.output).toContain('running the tests with playwright directly')
    expect(result.output).toContain('2 passed')
    expect(result.code).toBe(0)
  })

  test('a failing file is never reused', async () => {
    const s = (await project('pw-failing')).write('e2e/mul.spec.js', spec('multiplies', 'mul', '7'))
    expect(s.cli(['run', '--full']).code).not.toBe(0)
    expect(s.actions()).toEqual({ 'e2e/add.spec.js': 'skip', 'e2e/mul.spec.js': 'run' })
  })

  test('a request to a remote host blocks reuse unless the network is allowed', async () => {
    const s = (await project('pw-remote')).write(
      'e2e/mul.spec.js',
      spec('multiplies', 'mul', '6').replace(
        "await page.goto('/')",
        "await page.goto('/')\n  await page.evaluate(() => fetch('http://veyrum.invalid/data').catch(() => null))",
      ),
    )
    s.capture()
    expect(s.actions()).toEqual({ 'e2e/add.spec.js': 'skip', 'e2e/mul.spec.js': 'run' })
    expect(s.plan()['e2e/mul.spec.js']?.details).toEqual([
      'the check uses channels Veyrum does not observe: net-remote (veyrum.invalid:80)',
    ])
    const allowed = s.cli(['plan', '--allow', 'net'])
    expect(Object.fromEntries(allowed.decisions.map((d) => [d.check.path, d.action]))).toEqual({
      'e2e/add.spec.js': 'skip',
      'e2e/mul.spec.js': 'skip',
    })
  })

  test.skipIf(!python)('a server that is not a Node program blocks reuse', async () => {
    const port = await freePort()
    sandbox = new Sandbox('pw-python', { runner: 'playwright' })
    const s = sandbox
      .write(
        'playwright.config.js',
        config(port, `python3 -m http.server ${port} --bind 127.0.0.1 --directory public`),
      )
      .write('public/index.html', INDEX)
      .write('public/app.js', APP)
      .write('e2e/add.spec.js', spec('adds', 'add', '5'))
    s.capture()
    const decision = s.plan()['e2e/add.spec.js']
    expect(decision?.action).toBe('run')
    expect(decision?.details).toEqual([
      `the check uses channels Veyrum does not observe: server-unobserved (http://127.0.0.1:${port}: no observed program listened on port ${port})`,
    ])
  })
})
