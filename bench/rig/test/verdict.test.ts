import { expect, test } from 'vitest'
import { fileVerdict } from '../src/runners.ts'

test('only failed files fail; skipped and partly skipped files pass', () => {
  expect(fileVerdict('passed')).toBe('pass')
  expect(fileVerdict('failed')).toBe('fail')
  expect(fileVerdict('skipped')).toBe('pass')
  expect(fileVerdict('focused')).toBe('pass')
})
