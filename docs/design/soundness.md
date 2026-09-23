# Soundness model

Veyrum reuses a passing result for a test file only when every input the file consumed is
unchanged. This document defines what counts as an input, how each one is observed, and what
Veyrum assumes. Every channel listed here has at least one end-to-end scenario in
`packages/vitest/test/hazards-*.test.ts` or `packages/jest/test/hazards.test.ts`.

## The skip rule

A test file is reused when all of the following hold for some earlier record:

- the record is a pass, and the pass is evidence: no retry was needed, no snapshot was written
  and capture completed;
- the runtime key matches: Node version, platform, architecture, ICU, timezone, locale, Node
  flags, and runner versions (Vitest and Vite, or Jest);
- every shared input of the run that produced the record is unchanged: configuration files and
  their dependencies, `tsconfig`/`jsconfig` files, the packages the runner's main process loaded,
  and variables the main process read;
- every entry in the file's own closure is unchanged;
- no newly added file could shadow a module in the closure during resolution, and no new
  configuration-like file appeared;
- the record carries no flag the policy blocks.

If the latest record for a file is a failure, the file always runs.

## Closure entries

| Kind | Identity | Fingerprint | Observed by |
| --- | --- | --- | --- |
| `mod` | repository module | raw source digest, plus unit fingerprints of the executed code | V8 precise coverage (function granularity) on the code Vite served |
| `dep` | file loaded outside the transform pipeline, or a package manifest | content digest | V8 script list, `process.dlopen`, manifest lookup |
| `file` | file read through `fs` | content digest, or absent | `fs` and `fs/promises` hooks |
| `stat` | existence or type check | file, directory, other or absent | `fs` hooks |
| `dir` | directory listing | digest of entry names | `readdir` and `opendir` hooks |
| `env` | environment variable | value digest, or unset | `process.env` proxy |

## Unit fingerprints

Units are the module top level plus every function in the code V8 ran, which is Vite's
transform output. A unit's fingerprint is its canonical AST with positions, comments and raw
literal text removed. Nested functions appear only as signatures: kind, name, async, generator
and parameter shapes.

Fingerprinting transform output has three consequences:

- **Types are erased before fingerprinting.** Type-only edits never invalidate.
- **Build-time substitutions are visible.** `define` replacements, glob expansion and plugin
  output all appear in the fingerprinted code.
- **Changed modules must be re-transformed at plan time.** This goes through the project's own
  Vite pipeline, and only for files whose raw source changed.

Import aliases (`__vite_ssr_import_N__`) are renamed to their specifier, and install paths are
stripped, so fingerprints are stable across machines.

## Flags

Flags record channels the closure cannot fully observe.

| Flag | Meaning | Default policy |
| --- | --- | --- |
| `net-remote` | connection to a non-loopback host | blocks reuse |
| `spawn` | child process started | blocks reuse |
| `shared-worker` | isolation off, files share an isolate | blocks reuse |
| `snapshot-written` | the pass wrote a snapshot | not evidence |
| `flaky-suspect` | the pass needed a retry | not evidence |
| `capture-incomplete` | capture failed for the file | not evidence |
| `source-observed` | code read function source text | compare raw source |
| `positions-observed` | a snapshot embeds source positions | compare raw source |
| `net-local` | loopback connection | allowed |
| `eval` | code compiled from strings | allowed |
| `native-addon` | native module loaded, binary recorded | allowed |
| `env-enumerated` | whole environment read, every variable recorded | allowed |
| `writes-fs` | files written | allowed |

## Jest

Jest evaluates every module of a test file inside that file's own vm context, in worker processes
that host many files in turn. The capture window is the file's test environment: Veyrum wraps
each project's configured environment, begins capture in `setup` (before setup files and modules
run) and finishes in `teardown`. Everything else about the environment is the project's own.

Jest-specific observation rules, each covered by `packages/jest/test/hazards.test.ts`:

- **Test code is what Jest compiled into the file's context.** Sources are recorded as Jest
  compiles them (`vm.compileFunction`, `vm.Script`, `vm.SourceTextModule`). Scripts executed in
  the worker's own realm during the window are the runner and its transformers, not test code.
- **The toolchain is a shared input.** Packages the worker loads through Node's own loader
  (transformers, Babel plugins, presets), local files it loads the same way, and the variables the
  worker reads from its own environment (`BABEL_ENV`, CI detection) are shared inputs of the run.
  Tests read their context's copy of `process.env`, which is recorded per file.
- **Module reads by Jest's loader are not file inputs.** Jest's file cache reads each module
  before compiling it. Those reads are dropped for files that were then compiled (their content is
  recorded as a module, by what executed) and kept for everything else, such as JSON modules.
- **Resolution is observed.** Jest resolves modules in the worker through hooked `fs`, so the
  existence checks of resolution are recorded per file.
- **The haste map is not an input.** Jest indexes the repository in the main process by reading
  every file; the main-process recorder is paused while a haste map builds.
- **Transformer configuration is shared.** Babel, SWC, Browserslist, TypeScript and Jest
  configuration files are shared inputs, and a new one anywhere is a configuration-like addition.
- **Manual mocks apply by location.** A new file under any `__mocks__` directory is treated as a
  configuration-like addition.
- **Changed modules are re-transformed with the project's own Jest transform**, with the options
  the runtime uses for CommonJS or ECMAScript modules.

Known gap: a test file that selects its own environment with a `@jest-environment` docblock
bypasses the wrapper. It produces no capture, so it is never reused (it always runs).

## Assumptions

1. **Unhooked channels.** Outcomes do not depend on channels that are neither hooked nor
   flagged. Wall-clock time and randomness are the main ones. A test that depends on them is
   flaky by construction; flake detection and the audit handle it, not the cache.
2. **Main-process directory listings.** Listings made in the runner's main process are test
   discovery or `import.meta.glob`. A new test file has no evidence and runs, and modules that
   use `import.meta.glob` are re-transformed on every plan.
3. **Native module resolution.** Vite 8 resolves in native code, so a new file that changes
   resolution is detected by the shadowing rule (same stem as a module in the closure) and the
   configuration-like file rule. Other resolution changes are not observed.
4. **Stack traces outside snapshots.** A test that inspects stack traces without snapshotting
   them can observe line numbers that formatting edits change.
5. **Benign source readers.** Vitest's own reading of test callback source (fixture detection)
   is treated as benign.
6. **Volatile environment variables.** Variables in the volatile list (CI run identifiers,
   Vitest worker ids, terminal session variables) do not affect outcomes.

The audit (full runs on the main branch, plus sampled re-execution of reused files) is the
backstop for every assumption. Its escape rate is the real safety number.
