import { afterEach, describe, expect, test } from 'vitest'
import { Sandbox, testPython } from '../../../test/support/sandbox.ts'

/**
 * End-to-end scenarios for the pytest adapter, through the real CLI and `python -m pytest`. Each
 * records evidence, changes something, and asserts which files the plan runs. Skipped without a
 * Python 3.12 or later that has pytest (see testPython), except on Linux CI, where they must run.
 */

const python = testPython()
if (!python && process.env.CI !== undefined && process.platform === 'linux')
  throw new Error('No Python 3.12 or later with pytest; install them as the CI workflow does')

let sandbox: Sandbox | undefined
afterEach(() => sandbox?.dispose())

const project = (name: string): Sandbox => {
  sandbox = new Sandbox(name, { runner: 'pytest', python: python ?? undefined })
  // Modules under src/ are importable as the project configures it.
  sandbox.write('pytest.ini', '[pytest]\npythonpath = src\n')
  return sandbox
}

const CALC = 'def add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a * b\n'
const ADD_TEST = 'from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n'
const MUL_TEST = 'from calc import mul\n\n\ndef test_mul():\n    assert mul(2, 3) == 6\n'

describe.skipIf(!python)('pytest', () => {
  describe('code', () => {
    test('an edit invalidates only the files that executed the changed function', () => {
      const s = project('py-units')
        .write('src/calc.py', CALC)
        .write('tests/test_add.py', ADD_TEST)
        .write('tests/test_mul.py', MUL_TEST)
      expect(s.capture().code).toBe(0)
      expect(s.actions()).toEqual({ 'tests/test_add.py': 'skip', 'tests/test_mul.py': 'skip' })
      s.edit('src/calc.py', 'return a * b', 'return a * b * 1')
      expect(s.actions()).toEqual({ 'tests/test_add.py': 'skip', 'tests/test_mul.py': 'run' })
      expect(s.plan()['tests/test_mul.py']?.details).toEqual(['src/calc.py: mul changed'])
      const rerun = s.cli(['run'])
      expect(rerun.code).toBe(0)
      expect(rerun.outcomes.map((o) => [o.check.path, o.verdict, o.captured])).toEqual([
        ['tests/test_mul.py', 'pass', true],
      ])
      expect(s.actions()).toEqual({ 'tests/test_add.py': 'skip', 'tests/test_mul.py': 'skip' })
      // A full run runs files whose evidence is valid without capturing them again.
      const full = s.cli(['run', '--full'])
      expect(full.outcomes.map((o) => [o.check.path, o.verdict, o.captured])).toEqual([
        ['tests/test_add.py', 'pass', false],
        ['tests/test_mul.py', 'pass', false],
      ])
    })

    test('a formatting-only change reruns nothing', () => {
      const s = project('py-format')
        .write('src/calc.py', CALC)
        .write('tests/test_add.py', ADD_TEST)
        .write('tests/test_mul.py', MUL_TEST)
      s.capture()
      s.write(
        'src/calc.py',
        '# Arithmetic.\n\ndef add(a,   b):\n    return (a + b)  # sum\n\n\n\ndef mul(a, b):\n    return (\n        a * b\n    )\n',
      )
      s.edit('tests/test_add.py', 'assert add(1, 2) == 3', "assert add(1, 2) == (3)  # 'three'")
      expect(s.actions()).toEqual({ 'tests/test_add.py': 'skip', 'tests/test_mul.py': 'skip' })
    })

    test('a conftest.py change reruns the files that load it', () => {
      const s = project('py-conftest')
        .write('src/calc.py', CALC)
        .write('tests/unit/conftest.py', 'import pytest\n\n\n@pytest.fixture\ndef base():\n    return 1\n')
        .write('tests/unit/test_base.py', 'def test_base(base):\n    assert base == 1\n')
        .write('tests/unit/test_plain.py', 'def test_plain():\n    assert True\n')
        .write('tests/test_add.py', ADD_TEST)
      s.capture()
      s.edit('tests/unit/conftest.py', 'return 1', 'return 1 + 0')
      // Only the fixture's body changed: the file that uses it reruns, its sibling does not.
      expect(s.actions()).toEqual({
        'tests/test_add.py': 'skip',
        'tests/unit/test_base.py': 'run',
        'tests/unit/test_plain.py': 'skip',
      })
      // A new autouse fixture changes the conftest's top level: every file that loads it reruns.
      s.write(
        'tests/unit/conftest.py',
        'import pytest\n\n\n@pytest.fixture\ndef base():\n    return 1\n\n\n@pytest.fixture(autouse=True)\ndef always():\n    yield\n',
      )
      expect(s.actions()).toEqual({
        'tests/test_add.py': 'skip',
        'tests/unit/test_base.py': 'run',
        'tests/unit/test_plain.py': 'run',
      })
    })

    test('a new conftest.py reruns the files below it', () => {
      const s = project('py-new-conftest')
        .write('src/calc.py', CALC)
        .write('tests/unit/test_mul.py', MUL_TEST)
        .write('tests/test_add.py', ADD_TEST)
      s.capture()
      s.write('tests/unit/conftest.py', 'def pytest_runtest_setup(item):\n    raise RuntimeError("no")\n')
      expect(s.actions()).toEqual({ 'tests/test_add.py': 'skip', 'tests/unit/test_mul.py': 'run' })
    })

    test('a failing file is never reused', () => {
      const s = project('py-failing')
        .write('src/calc.py', CALC)
        .write('tests/test_fail.py', 'def test_fails():\n    assert 1 == 2\n')
        .write('tests/test_add.py', ADD_TEST)
      const result = s.cli(['run', '--full'])
      expect(result.code).not.toBe(0)
      expect(result.outcomes.map((o) => [o.check.path, o.verdict]).sort()).toEqual([
        ['tests/test_add.py', 'pass'],
        ['tests/test_fail.py', 'fail'],
      ])
      expect(s.actions()).toEqual({ 'tests/test_add.py': 'skip', 'tests/test_fail.py': 'run' })
    })
  })

  describe('inputs', () => {
    test('a fixture file a test reads is an input', () => {
      const s = project('py-fixture')
        .write('fixtures/x.txt', 'a')
        .write('fixtures/other.txt', 'o')
        .write(
          'tests/test_read.py',
          'from pathlib import Path\n\n\ndef test_read():\n    assert Path("fixtures/x.txt").read_text() in ("a", "b")\n',
        )
        .write('tests/test_add.py', ADD_TEST)
        .write('src/calc.py', CALC)
      s.capture()
      expect(s.actions()).toEqual({ 'tests/test_add.py': 'skip', 'tests/test_read.py': 'skip' })
      s.write('fixtures/other.txt', 'p')
      expect(s.actions()).toEqual({ 'tests/test_add.py': 'skip', 'tests/test_read.py': 'skip' })
      s.write('fixtures/x.txt', 'b')
      expect(s.actions()).toEqual({ 'tests/test_add.py': 'skip', 'tests/test_read.py': 'run' })
      expect(s.plan()['tests/test_read.py']?.details).toEqual(['fixtures/x.txt changed'])
    })

    test('an environment variable a test reads is an input', () => {
      const s = project('py-env')
        .write(
          'tests/test_env.py',
          'import os\n\n\ndef test_env():\n    assert os.environ.get("GREETING") != "boom"\n',
        )
        .write('tests/test_add.py', ADD_TEST)
        .write('src/calc.py', CALC)
      s.capture({ GREETING: 'hi' })
      expect(s.actions({ GREETING: 'hi' })).toEqual({
        'tests/test_add.py': 'skip',
        'tests/test_env.py': 'skip',
      })
      expect(s.actions({ GREETING: 'bye' })).toEqual({
        'tests/test_add.py': 'skip',
        'tests/test_env.py': 'run',
      })
      expect(s.plan({ GREETING: 'bye' })['tests/test_env.py']?.details).toEqual([
        'environment variable GREETING changed',
      ])
    })

    test('a Python child process is traced: what it reads and runs are inputs', () => {
      const s = project('py-child')
        .write('fixtures/x.txt', 'a')
        .write(
          'tools/show.py',
          'import os\n\n\ndef show():\n    print(open("fixtures/x.txt").read() + os.environ.get("SUFFIX", ""))\n\n\ndef unused():\n    return 1\n\n\nshow()\n',
        )
        .write(
          'tests/test_child.py',
          'import os\nimport subprocess\nimport sys\n\n\ndef test_child():\n    env = {**os.environ, "SUFFIX": "!"}\n    out = subprocess.run([sys.executable, "tools/show.py"], env=env, capture_output=True, text=True, check=True)\n    assert out.stdout.strip() in ("a!", "b!")\n',
        )
        .write('tests/test_add.py', ADD_TEST)
        .write('src/calc.py', CALC)
      s.capture()
      expect(s.actions()).toEqual({ 'tests/test_add.py': 'skip', 'tests/test_child.py': 'skip' })
      // The variable the test set for the child is the test's own code, not the environment.
      expect(s.actions({ SUFFIX: '?' })).toEqual({
        'tests/test_add.py': 'skip',
        'tests/test_child.py': 'skip',
      })
      s.edit('tools/show.py', 'return 1', 'return 2')
      expect(s.actions()['tests/test_child.py']).toBe('skip')
      s.edit('tools/show.py', 'os.environ.get("SUFFIX", "")', 'os.environ.get("SUFFIX", "") + ""')
      expect(s.plan()['tests/test_child.py']?.details).toEqual(['tools/show.py: show changed'])
      s.edit('tools/show.py', ' + ""', '')
      s.write('fixtures/x.txt', 'b')
      expect(s.plan()['tests/test_child.py']?.details).toEqual(['fixtures/x.txt changed'])
    })

    test('another program a test starts blocks reuse', () => {
      const s = project('py-spawn')
        .write(
          'tests/test_spawn.py',
          'import subprocess\n\n\ndef test_spawn():\n    assert subprocess.run(["sh", "-c", "exit 0"]).returncode == 0\n',
        )
        .write('tests/test_add.py', ADD_TEST)
        .write('src/calc.py', CALC)
      s.capture()
      const decision = s.plan()['tests/test_spawn.py']
      expect(decision?.action).toBe('run')
      expect(decision?.details).toEqual(['the check uses channels Veyrum does not observe: spawn (sh)'])
      expect(s.actions()['tests/test_add.py']).toBe('skip')
    })

    test('a new module that would shadow an import reruns the files that imported it', () => {
      const s = project('py-shadow')
        .write('src/calc.py', CALC)
        .write('tests/test_add.py', ADD_TEST)
        .write('tests/test_plain.py', 'def test_plain():\n    assert True\n')
      s.capture()
      // pytest puts the test file's directory first on sys.path: tests/calc.py would be imported.
      s.write('tests/calc.py', 'def add(a, b):\n    return 0\n')
      expect(s.actions()).toEqual({ 'tests/test_add.py': 'run', 'tests/test_plain.py': 'skip' })
    })
  })
})
