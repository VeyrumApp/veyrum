import { afterEach, expect, test } from 'vitest'
import { runtimeFacts, runtimeKeyOf } from '../src/runtime.ts'

const saved = process.env.NODE_OPTIONS
afterEach(() => {
  if (saved === undefined) delete process.env.NODE_OPTIONS
  else process.env.NODE_OPTIONS = saved
})

const keyWith = (nodeOptions: string): string => {
  process.env.NODE_OPTIONS = nodeOptions
  return runtimeKeyOf(runtimeFacts())
}

test('profiling and report flags do not change the runtime key; other Node flags do', () => {
  const plain = keyWith('--max-old-space-size=4096')
  expect(
    keyWith(
      '--max-old-space-size=4096 --cpu-prof --cpu-prof-dir=/tmp/p --report-on-signal --report-signal=SIGUSR2',
    ),
  ).toBe(plain)
  expect(keyWith('--max-old-space-size=4096 --no-experimental-strip-types')).not.toBe(plain)
})
