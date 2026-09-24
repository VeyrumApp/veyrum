# Running Veyrum in GitHub Actions

Veyrum needs its evidence store to survive between workflow runs. The simplest store is the
`.veyrum` directory saved with `actions/cache`: runs on the main branch record evidence, and pull
requests restore it and reuse what is still valid.

Veyrum is not published to npm yet. Until it is, build it from source in the workflow and run
`node <checkout>/packages/cli/dist/main.js` where the examples below use `veyrum`.

## Shadow mode first

Shadow mode changes nothing about what runs. Every test file runs, and Veyrum reports which of them
it would have reused and whether any of those fail (an escape). Run it for a few weeks before
skipping anything.

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
  run: veyrum run --full --audit --summary "$GITHUB_STEP_SUMMARY"
```

The job summary states how many test files and how much recorded test time Veyrum would have
reused, why the others had to run, and names every escape.

## Skipping on pull requests

Once shadow mode shows no escapes, pull requests can reuse evidence. Keep full runs on the main
branch: they record fresh evidence and audit every reuse decision.

```yaml
- name: Test
  run: |
    if [ "${{ github.event_name }}" = "pull_request" ]; then
      # Run what changed, plus a random 10% of reusable files as canaries.
      veyrum run --canary 0.1 --summary "$GITHUB_STEP_SUMMARY"
    else
      veyrum run --full --audit --summary "$GITHUB_STEP_SUMMARY"
    fi
```

## Parallel jobs

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
      - run: veyrum run --shard ${{ matrix.shard }}/4 --canary 0.1 --summary "$GITHUB_STEP_SUMMARY"
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
      - run: veyrum merge stores/*/store.sqlite
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
  the key (`veyrum-${{ runner.os }}-node${{ matrix.node }}-...`), or merge the legs' stores as
  above.
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
