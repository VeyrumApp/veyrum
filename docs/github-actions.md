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

## Notes

- **Runtime.** Evidence is only reused on the same Node version, platform, architecture, locale,
  time zone and runner version. A matrix of Node versions keeps separate evidence per leg in one
  store.
- **CI variables.** Run identifiers such as `GITHUB_SHA` and `GITHUB_RUN_ID` are never recorded,
  so they do not invalidate evidence. Variables tests actually read, such as `CI`, are recorded.
- **Cache size.** The store keeps content-addressed closures, so it grows slowly. GitHub evicts
  caches beyond 10 GB per repository, least recently used first; losing the store only means the
  next run records evidence again.
- **Forks.** Pull requests from forks can restore the base branch's cache but cannot save one.
