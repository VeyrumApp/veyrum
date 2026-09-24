# Running Veyrum in GitHub Actions

## The action

`VeyrumApp/veyrum@v1` is a composite action that restores the evidence store, runs Veyrum, and
saves the store back. It covers a single job; for parallel jobs see below.

```yaml
- uses: VeyrumApp/veyrum@v1
```

By default this is shadow mode: every test file runs (`veyrum run --full --audit`), and the job
summary reports which files it would have reused and whether any of those reuses would have been
wrong (an escape). Run it for a few weeks before skipping anything.

Once shadow mode shows no escapes, switch to enforce mode: files with valid evidence are skipped.

```yaml
- uses: VeyrumApp/veyrum@v1
  with:
    mode: enforce
```

### Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `mode` | `shadow` | `shadow` runs `veyrum run --full --audit`; `enforce` runs `veyrum run` |
| `version` | `latest` | npm version of the `veyrum` package to use |
| `args` | (empty) | extra arguments appended to the `veyrum run` command |
| `store-key-prefix` | `veyrum` | prefix used in the `actions/cache` key |

The action caches `.veyrum/store.sqlite` with `actions/cache`, keyed by the prefix, `runner.os`,
the branch and the commit, and falls back to the newest store of the same branch, then of the
base branch (or the repository's default branch outside a pull request). It runs the package
with `npx`, so it needs Node on `PATH` but does not itself set up Node or cache npm or pnpm
packages; do that in an earlier step if the job needs it for anything else.

## Advanced: a manual workflow

The action above is one job restoring one cache and running one `veyrum run`. Sharding a suite
across parallel jobs, or wiring shadow and enforce mode into the same job by event type, needs
more control than the action's inputs give, so those cases are written out by hand below, calling
`veyrum` directly instead of through the action.

### Shadow mode by hand

```yaml
- name: Restore Veyrum evidence
  uses: actions/cache@v4
  with:
    path: .veyrum/store.sqlite
    # A new key every run, so the cache always saves the newest store...
    key: veyrum-${{ runner.os }}-${{ github.ref_name }}-${{ github.sha }}
    # ...and restores the newest store of this branch, or of the base branch for a new pull request.
    restore-keys: |
      veyrum-${{ runner.os }}-${{ github.ref_name }}-
      veyrum-${{ runner.os }}-${{ github.base_ref || github.event.repository.default_branch }}-

- name: Test (Veyrum shadow mode)
  run: npx --yes veyrum run --full --audit --summary "$GITHUB_STEP_SUMMARY"
```

The job summary states how many test files and how much recorded test time Veyrum would have
reused, why the others had to run, and names every escape.

### Skipping on pull requests

Once shadow mode shows no escapes, pull requests can reuse evidence. Keep full runs on the main
branch: they record fresh evidence and audit every reuse decision.

```yaml
- name: Test
  run: |
    if [ "${{ github.event_name }}" = "pull_request" ]; then
      # Run what changed, plus a random 10% of reusable files as canaries.
      npx --yes veyrum run --canary 0.1 --summary "$GITHUB_STEP_SUMMARY"
    else
      npx --yes veyrum run --full --audit --summary "$GITHUB_STEP_SUMMARY"
    fi
```

### Parallel jobs

A suite split across jobs uses `--shard <index>/<count>`. Veyrum splits the test files by their
paths alone, so every file belongs to exactly one shard whatever evidence each job restored, and
each job plans and runs only its own files. Each job then uploads its store, and a last job
merges them and saves the cache.

```yaml
jobs:
  test:
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      # ...checkout, install, build...
      - uses: actions/cache/restore@v4
        with:
          path: .veyrum/store.sqlite
          key: veyrum-${{ runner.os }}-${{ github.ref_name }}-${{ github.sha }}
          restore-keys: |
            veyrum-${{ runner.os }}-${{ github.ref_name }}-
            veyrum-${{ runner.os }}-${{ github.base_ref || github.event.repository.default_branch }}-
      - run: npx --yes veyrum run --shard ${{ matrix.shard }}/4 --canary 0.1 --summary "$GITHUB_STEP_SUMMARY"
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: veyrum-store-${{ matrix.shard }}
          path: .veyrum/store.sqlite

  evidence:
    needs: test
    if: always()
    runs-on: ubuntu-latest
    steps:
      # ...checkout and install Veyrum...
      - uses: actions/download-artifact@v4
        with:
          pattern: veyrum-store-*
          path: stores
      - run: npx --yes veyrum merge stores/*/store.sqlite
      - uses: actions/cache/save@v4
        with:
          path: .veyrum/store.sqlite
          key: veyrum-${{ runner.os }}-${{ github.ref_name }}-${{ github.sha }}
```

If Veyrum fails inside a shard before any test ran, that job runs every test file with the
project's runner, not the runner's own shard: the runner splits files differently, and a file of
that shard could otherwise run in no job.

## Notes

- **Runtime.** Evidence is only reused on the same Node version, platform, architecture, locale,
  time zone and runner version. A store can hold evidence for several runtimes, but two matrix
  legs saving the same cache key race and one leg's evidence is lost: put the matrix values in
  the key (`veyrum-${{ runner.os }}-node${{ matrix.node }}-...`, or `store-key-prefix` with the
  action), or merge the legs' stores as above.
- **Size.** After every run Veyrum keeps, per test file and runtime, only the records the planner
  still reads, with the closures they refer to, and drops cached module fingerprints that no run
  has used in 50 runs. The escape record is kept in full.
- **CI variables.** Run identifiers such as `GITHUB_SHA` and `GITHUB_RUN_ID` are never recorded,
  so they do not invalidate evidence. Variables tests actually read, such as `CI`, are recorded.
- **Coverage.** Full runs report coverage of the whole suite. A run that reuses evidence reports
  coverage of the files that ran: upload it as partial coverage (Codecov carryforward flags,
  for example), or take coverage from the main branch's full runs. Coverage thresholds checked
  by the runner apply to what ran.
- **Cache size.** GitHub evicts caches beyond 10 GB per repository, least recently used first;
  losing the store only means the next run records evidence again.
- **Forks.** Pull requests from forks can restore the base branch's cache but cannot save one.
