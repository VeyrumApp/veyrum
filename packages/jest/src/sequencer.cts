/**
 * Jest test sequencer used in Veyrum runs: Jest's own order, with the files that need capture
 * first. A file whose evidence is still valid runs without capture, and a worker ends its coverage
 * session when it reaches one; putting those files last means each worker does so at most once.
 *
 * Copied next to the environment wrapper under a node_modules directory, so it must stay
 * self-contained: no relative imports.
 */
interface SequencerConfig {
  outDir: string
  sequencer: string
}

interface TestLike {
  path: string
}

type SequencerClass = new (
  ...args: unknown[]
) => { sort(tests: TestLike[]): TestLike[] | Promise<TestLike[]> }

const fs = require('node:fs') as typeof import('node:fs')
const path = require('node:path') as typeof import('node:path')

const raw = process.env.VEYRUM_JEST_CAPTURE
if (!raw) throw new Error('Veyrum: the Jest sequencer was loaded outside a Veyrum run')
const config = JSON.parse(raw) as SequencerConfig
const loaded = require(config.sequencer) as { default?: SequencerClass } | SequencerClass
const Base = (typeof loaded === 'function' ? loaded : loaded.default) as SequencerClass

function captureFirst(tests: TestLike[]): TestLike[] {
  let plain: Set<string>
  try {
    plain = new Set(
      JSON.parse(fs.readFileSync(path.join(config.outDir, 'uncaptured.json'), 'utf8')) as string[],
    )
  } catch {
    return tests
  }
  return [...tests.filter((t) => !plain.has(t.path)), ...tests.filter((t) => plain.has(t.path))]
}

class VeyrumSequencer extends Base {
  override sort(tests: TestLike[]): TestLike[] | Promise<TestLike[]> {
    const sorted = super.sort(tests)
    return sorted instanceof Promise ? sorted.then(captureFirst) : captureFirst(sorted)
  }
}

module.exports = VeyrumSequencer
