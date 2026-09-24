import { spawn } from 'node:child_process'
import path from 'node:path'
import { rawFs, unobserved } from '@veyrum/capture'
import { type Digest, digest, type ModuleTransformer } from '@veyrum/core'

/** A ModuleTransformer for Python modules that fingerprints files in batches, one process each. */
export interface PytestTransformer extends ModuleTransformer {
  /** Fingerprints these files in one process, ahead of the planner asking for them. */
  prefetch(absolutePaths: readonly string[]): Promise<void>
}

type Units = Readonly<Record<string, Digest>> | null

/**
 * Unit fingerprints of Python modules as they are now, computed by the same code the capture
 * plugin uses (python/veyrum_fingerprint.py) with the project's Python: CPython runs a module as
 * its source says, so the source is what is fingerprinted. Used only for modules whose source
 * changed. Requests made together (the planner asks for several at once) share one process.
 */
export function createTransformer(root: string, python: string, pythonDir: string): PytestTransformer {
  const results = new Map<string, { readonly digest: Digest; readonly units: Promise<Units> }>()
  let queue: { file: string; resolve: (units: Units) => void; reject: (error: unknown) => void }[] = []

  const flush = (): void => {
    const batch = queue
    queue = []
    if (batch.length === 0) return
    fingerprint(
      python,
      pythonDir,
      root,
      batch.map((b) => b.file),
    ).then(
      (out) => {
        for (const b of batch) b.resolve(out[b.file] ?? null)
      },
      (error: unknown) => {
        for (const b of batch) b.reject(error)
      },
    )
  }

  const request = (file: string): Promise<Units> => {
    let current: Digest
    try {
      current = digest(rawFs.readFileSync(file) as Buffer)
    } catch {
      return Promise.resolve(null)
    }
    const cached = results.get(file)
    if (cached && cached.digest === current) return cached.units
    const units = new Promise<Units>((resolve, reject) => {
      if (queue.length === 0) setImmediate(flush)
      queue.push({ file, resolve, reject })
    })
    results.set(file, { digest: current, units })
    return units
  }

  return {
    async prefetch(absolutePaths: readonly string[]): Promise<void> {
      await Promise.all(absolutePaths.map((file) => request(file).catch(() => null)))
    },
    units(absolutePath: string): Promise<Units> {
      return request(absolutePath)
    },
  }
}

/** Runs the fingerprinting program on the files: their units, or null for unreadable files. */
function fingerprint(
  python: string,
  pythonDir: string,
  root: string,
  files: readonly string[],
): Promise<Record<string, Units>> {
  return unobserved(
    () =>
      new Promise<Record<string, Units>>((resolve, reject) => {
        // Isolated mode: fingerprints depend on the source and the Python version only.
        const child = spawn(python, ['-I', path.join(pythonDir, 'veyrum_fingerprint.py'), root], {
          cwd: root,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        const out: Buffer[] = []
        const err: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
        child.on('error', reject)
        child.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`fingerprinting Python modules failed: ${Buffer.concat(err).toString()}`))
            return
          }
          try {
            resolve(JSON.parse(Buffer.concat(out).toString('utf8')) as Record<string, Units>)
          } catch (error) {
            reject(error)
          }
        })
        child.stdin.end(JSON.stringify(files))
      }),
  )
}
