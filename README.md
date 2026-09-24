# Veyrum

Veyrum runs only the test files whose result could have changed. For every test file it records
the exact inputs the file consumed while it ran, and it reuses a passing result only when every
one of those inputs is unchanged.

It is not test prediction. A test file is skipped only when Veyrum can show that nothing it
observed has changed. Anything unknown means the file runs.

## How it works

1. **Capture.** During a normal Vitest or Jest run, Veyrum records each test file's input closure:
   - the functions it executed, fingerprinted on the code V8 actually ran;
   - every module it loaded;
   - the files, directories and environment variables it read;
   - the dependency files and manifests it used;
   - the runner's own configuration.
2. **Fingerprint.** Unit fingerprints ignore comments, formatting and type-only edits, but not
   anything a test can observe: function bodies, arity, names, module-level values.
3. **Plan.** Before the next run, Veyrum compares every recorded input with the current tree. A
   test file is reused only when all of them match and no channel Veyrum cannot observe was
   used, such as remote network, child processes or shared workers.
4. **Explain.** Every decision names the evidence it reused, or the input that changed.

```
$ veyrum plan
reuse test/add.test.ts
        58 recorded inputs unchanged (evidence 8KRWKdb6)
run   test/b.test.ts
        src/other.ts: twice changed
```

## Usage

```
veyrum run --full        Run every test file; record evidence where it is missing or stale
veyrum run               Run test files whose inputs changed; reuse evidence for the rest
veyrum plan              Show what would run and why
veyrum explain <file>    Explain one decision
veyrum stats             Evidence store statistics
veyrum merge <stores>    Add other stores' evidence (parallel CI jobs) to this one
```

`--shard <index>/<count>` splits a run across parallel jobs (see `docs/github-actions.md`).

Coverage is collected as the project configures it (`--coverage` and `--no-coverage` override
that), with Vitest's v8 provider or Jest's `coverageProvider: 'v8'`. Veyrum shares V8's
coverage with the project, whose report is the one it gets without Veyrum. A run that reuses
evidence reports coverage of the files that ran; a full run reports everything.

Recording is what costs time, so a full run records only where it is needed: a file whose
evidence is still valid runs at full speed, and its existing record already describes that
execution (`--record-all` records every file). On Linux (x64 and arm64), child processes a test
starts are traced too (see `docs/design/soundness.md`).

Evidence is stored in `.veyrum/store.sqlite`. It holds digests, repository paths, test names,
outcomes and durations, never source code or environment variable values.

Vitest 4 and later and Jest 29 and later are supported on Node 22.15 or later.

Under Jest, `VEYRUM_JEST_COVERAGE=binary` lowers capture overhead for projects whose transformer
type-checks inside the test workers (ts-jest without `isolatedModules`), and raises it for most
others. Both modes record the same evidence. The runner is detected from the
project's configuration; `--runner vitest|jest` overrides it.

## Repository layout

| Path | What it holds |
| --- | --- |
| `packages/core` | Evidence model, unit fingerprints, store, planner and policy |
| `packages/capture` | Runner-agnostic input capture: fs, env, network, process and V8 coverage hooks |
| `packages/vitest` | Vitest adapter: worker preload, setup file, plan-time transforms through Vite |
| `packages/jest` | Jest adapter: environment wrapper, reporter, plan-time transforms through Jest |
| `packages/cli` | The `veyrum` command |
| `bench/rig` | Replay benchmark against baseline selectors, with a mutation oracle |
| `bench/corpora` | Repositories to replay |
| `docs/design` | Soundness model and assumptions |
| `docs/github-actions.md` | Shadow mode and pull-request skipping in GitHub Actions |

## Development

```
pnpm install
pnpm build
pnpm test        # unit tests and the end-to-end hazard suite
pnpm lint
pnpm smoke:pack  # installs the packed packages into fresh Vitest and Jest projects
```

The hazard suites (`packages/*/test/hazards*.test.ts`) build small real projects,
record evidence, apply one edit and assert the planner's decision. They cover every channel
listed in `docs/design/soundness.md`.

## Benchmark

```
node bench/rig/dist/main.js replay bench/corpora/vue-core.json
node bench/rig/dist/main.js report bench/corpora/vue-core.json
```

`summary` takes several corpora and renders one table across them, with a combined 95% bound on
the escape rate. The `Replay` workflow runs the replays in parallel shards on GitHub Actions and
ends with that table.

The rig replays first-parent history. At each commit it computes every selector's choice from
evidence recorded at earlier commits only, then runs the full suite for ground truth. Sampled
commits also get mutants, whose killing test files are found by a plain full run.

The selectors compared are:

- retest-all;
- naive changed-file matching;
- Vitest's own `--changed`;
- Datadog-style coverage matching;
- whole-file closure identity;
- Veyrum.
