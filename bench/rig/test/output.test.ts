import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { readOutput } from '../src/runners.ts'

/** The layout the CLI's --json writes: one array item per line. */
const OUTPUT = `{
"runtimeKey": "k",
"decisions": [
{"check":{"path":"a.test.ts"},"action":"run"},
{"check":{"path":"b.test.ts"},"action":"skip"}
],
"records": [
{"id":"r1","closureSize":3,"note":"${'x'.repeat(2000)}"}
],
"outcomes": [],
"timings": {"runMs":5,"recordMs":1}
}
`

test('line-by-line reading gives what JSON.parse gives, without the records', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rig-output-')), 'out.json')
  fs.writeFileSync(file, OUTPUT)
  const whole = readOutput<Record<string, unknown>>(file)
  const lines = readOutput<Record<string, unknown>>(file, 0)
  expect(lines).toEqual({ ...whole, records: [] })
  expect(lines.decisions).toHaveLength(2)
  expect(lines.timings).toEqual({ runMs: 5, recordMs: 1 })
  fs.rmSync(path.dirname(file), { recursive: true })
})
