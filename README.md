# Veyrum

Veyrum runs only the test files whose result could have changed. For every test file it records
the exact inputs the file consumed while it ran, and it reuses a passing result only when every
one of those inputs is unchanged.

It is not test prediction. A test file is skipped only when Veyrum can show that nothing it
observed has changed. Anything unknown means the file runs.

## Quickstart

```
npx veyrum run
```

The first run has no evidence, so every test file runs and Veyrum records its inputs. Later runs
reuse a file's result when nothing it depends on has changed, and run it otherwise.

In CI, use the action in shadow mode first: every test file still runs, and the job summary
reports what would have been reused and whether any of that reuse would have been wrong.

```yaml
- uses: VeyrumApp/veyrum@v1
```

Once shadow mode shows no wrong reuse, switch to `mode: enforce` and files with valid evidence
are skipped. See `docs/github-actions.md` for the cache keys, inputs and a manual workflow for
sharded jobs.

Vitest 4 and later, Jest 29 and later, Mocha 10 and later, Node's built-in test runner
(`node --test`) and pytest (on Python 3.12 or later, `--python` picks the interpreter) are
supported, on Node 22.15 or later, on Linux, macOS and Windows. Child processes a test starts are
traced natively on Linux; Node child processes and worker threads, and Python child processes of
pytest tests, are traced on every platform.

## How it works

1. **Capture.** During a normal Vitest, Jest, Mocha or `node --test` run, Veyrum records each test
   file's input closure:
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
that), with V8 or Istanbul (Jest's default) and the report the project gets without Veyrum. A run that reuses
evidence reports coverage of the files that ran; a full run reports everything.

Recording is what costs time, so a full run records only where it is needed: a file whose
evidence is still valid runs at full speed, and its existing record already describes that
execution (`--record-all` records every file). On Linux (x64 and arm64), child processes a test
starts are traced too, statically linked and Go programs included (see `docs/design/soundness.md`).

Evidence is stored in `.veyrum/store.sqlite`. It holds digests, repository paths, test names,
outcomes and durations, never source code or environment variable values.

The runner is detected from the project's configuration (a test script running `node --test`
selects Node's runner, a `.mocharc.*` file or a `mocha` dependency selects Mocha);
`--runner vitest|jest|mocha|node-test` overrides it. Under Mocha, each test file runs in a process
of its own, so root hooks and global fixtures run once per file.

## Repository layout

| Path | What it holds |
| --- | --- |
| `packages/core` | Evidence model, unit fingerprints, store, planner and policy |
| `packages/capture` | Runner-agnostic input capture: fs, env, network, process and V8 coverage hooks |
| `packages/vitest` | Vitest adapter: worker preload, setup file, plan-time transforms through Vite |
| `packages/jest` | Jest adapter: environment wrapper, reporter, plan-time transforms through Jest |
| `packages/mocha` | Mocha adapter: one process per test file through the project's Mocha, reporter |
| `packages/node-test` | Adapter for Node's test runner: capture preload and reporter |
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
pnpm smoke:pack  # installs the packed packages into fresh Vitest, Jest and Mocha projects
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
