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
  modules of custom Vitest environments and global setup, and variables the main process read;
- every entry in the file's own closure is unchanged;
- no newly added file could shadow a module in the closure during resolution, and no new
  configuration-like file appeared that can affect the file: a new manifest, tsconfig, runner or
  Babel configuration, or `__mocks__` file affects the files below its directory; a new `.env`
  file, install setting, or any configuration-like file at the repository root affects all;
- the record carries no flag the policy blocks.

If the latest record for a file is a failure, the file always runs.

## Closure entries

| Kind | Identity | Fingerprint | Observed by |
| --- | --- | --- | --- |
| `mod` | repository module | raw source digest, plus unit fingerprints of the executed code | V8 precise coverage (function granularity) on the code Vite served |
| `dep` | file loaded outside the transform pipeline, or a package manifest | content digest | V8 script list, `process.dlopen`, manifest lookup |
| `file` | file read through `fs` | content digest, or absent | `fs` and `fs/promises` hooks |
| `manifest` | repository `package.json` the toolchain read, or that governs a module | manifest digest (below), or absent | runner main process reads, module lookup, reads by known manifest readers |
| `stat` | existence or type check | file, directory, other or absent | `fs` hooks |
| `dir` | directory listing | digest of entry names | `readdir` and `opendir` hooks |
| `env` | environment variable | value digest, or unset | `process.env` proxy; the whole environment of a traced child process |
| `pkgname` | package name Jest looked up in its haste map | digest of the repository manifests declaring it | Jest resolver hook |

Reads, checks and listings made by traced child processes are recorded as the entries above,
as if the test file had made them (see Child processes).

A manifest digest covers every field of a `package.json` except the package's own `version`,
the version ranges of dependencies (their names are kept), `scripts`, install and publish settings (`engines`,
`packageManager`, `publishConfig`, `files`, `private`) and descriptive metadata. The toolchain reads repository manifests for module
format, resolution, dependency names and its own configuration fields (`jest`, `babel`,
`browserslist`), and what is actually installed is recorded by each loaded package's own
manifest. A manifest a test reads or imports itself is a `file` or `mod` entry, compared in full,
and so is one a runner configuration file imports. Manifest readers are recognized by stack
frame: Jest's resolver and Babel's configuration loader.

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

Two refinements keep a private helper from invalidating every importer of its module:

- **Private functions are left out of the top level.** A module-level function (a declaration,
  or a `const` initialized with a function) is private when every mention of its name anywhere in
  the module is the callee of a plain call: it is not exported, passed, stored, constructed with
  `new` or used as a tag, and the module uses no `eval` or `with`. Its length, name and kind can
  only be observed by calling it, which executes it, so its own unit covers every test that could
  notice a change. Mentions are counted by name across scopes, which only errs toward escaping.
- **Every unit records how the names it mentions resolve.** For each name, the unit's fingerprint
  includes what the name is bound to at module level (function, class, variable, import) or that
  it is not bound there (a global). Adding, removing or retyping a module-level binding therefore
  changes exactly the units that mention its name, including units whose global reference is now
  captured by a new module binding.

Vite's list of imported names is left out for repository modules: it is only checked for
externalized dependencies, where a CommonJS package can lack a named export.

## Flags

Flags record channels the closure cannot fully observe.

| Flag | Meaning | Default policy |
| --- | --- | --- |
| `net-remote` | connection to a non-loopback host | blocks reuse |
| `spawn` | child process that could not be traced, or a worker thread | blocks reuse |
| `shared-worker` | isolation off, files share an isolate | blocks reuse |
| `snapshot-written` | the pass wrote a snapshot | not evidence |
| `flaky-suspect` | the pass needed a retry | not evidence |
| `capture-incomplete` | capture failed for the file | not evidence |
| `source-observed` | code read function source text that could not be located | compare raw source |
| `positions-observed` | a snapshot embeds source positions | compare raw source |
| `net-local` | loopback connection | allowed |
| `eval` | code compiled from strings | allowed |
| `native-addon` | native module loaded, binary recorded | allowed |
| `env-enumerated` | whole environment read, every variable recorded | allowed |
| `writes-fs` | files written | allowed |

## Child processes

A child process a test starts (`child_process`, including through a shell) is traced on Linux x64
and arm64. How depends on the program:

- **Through the C library.** A dynamically linked, 64-bit ELF program that is not written in Go,
  or a script whose interpreter is one, gets a preloaded library (`packages/capture/native/trace.c`)
  that records the files the process and its descendants open, check and list, the programs they
  execute, and where they connect.
- **Through ptrace.** A statically linked or Go program for the machine makes its system calls
  itself, so the library cannot see them. It runs under `veyrum-exec`
  (`packages/capture/native/exec.c`), which attaches a ptrace tracer before the exec. A seccomp
  filter stops the program only at the system calls that reach files by path, execute programs or
  connect, and only at their entry. The tracer records them in the same log, for every thread and
  descendant, and writes each event before the stopped thread continues. Whether a path existed
  is resolved when the file's evidence is recorded, as for any read (a path absent when the
  program looked and present by then reads as changed, which reruns), and a failed connection
  counts as network use. The program keeps the process it was started in
  (pid, parent, streams, signals, exit status); the tracer is a detached grandchild. Tracing sets
  `no_new_privs`, so a set-user-ID program started this way does not gain privileges. Where
  ptrace is not allowed (Yama `ptrace_scope` 2 or 3, a container that forbids it, a debugger
  already attached), the program runs untraced and blocks reuse, as below.

The test file's closure gets what its children did like its own reads. On top of that:

- **The program and its lookup are inputs.** The executed file's content, and the absence of the
  program in PATH directories searched before it.
- **The whole inherited environment is an input.** A shell imports every variable at startup,
  so each variable the child receives from the test's environment is recorded, not just those it
  reads. A value the call sets itself (`spawn(cmd, { env: { ...process.env, TZ: 'UTC' } })`) comes
  from the test's code, which is recorded already.
- **Descendants stay traced.** Every exec restores the preloaded tracer's variables, even when a
  program clears its environment for its own children; under ptrace, every descendant is followed
  by the tracer itself.
- **Anything else blocks reuse.** A program for another machine or a 32-bit one, a raw `execve`
  system call or `fexecve` from a dynamically linked program, `glob`, `ftw` and `nftw` (which read
  directories internally), system calls of another architecture, `io_uring`, `open_by_handle_at`,
  and a statically linked shell started through a `shell` option are reported as untraceable, and
  the check gets the `spawn` flag. So does a worker thread, and a child process on any other
  platform.

Temporary files are ignored for children as for tests. Unix socket connections count as local
network use, as they do for the test itself.

## The project's own coverage

V8 keeps one precise-coverage state per isolate: when two inspector sessions each start precise
coverage, every take resets the counts the other would have reported, and a stop turns coverage
off for both. When a project collects V8 coverage (Vitest's v8 provider, Jest's
`coverageProvider: 'v8'`) in the same workers as capture, both therefore go through one session
(`packages/capture/src/coverage.ts`). Coverage calls from the project's session are served by it,
every take is handed to every consumer, and each consumer's take returns everything reported since
its own last take. Its report is the one the project gets without Veyrum.

- **The mode is set before code runs.** Switching from binary to count coverage makes V8 stop
  reporting functions compiled before the switch. Capture starts in the mode the project's
  coverage uses, at the start of the worker. If the mode still changes while a file is being
  captured, its record is not evidence.
- **Istanbul coverage is seen through.** Istanbul (Jest's default Babel coverage, Vitest's
  istanbul provider) instruments the code that runs with a coverage function and counters, which
  plan-time transforms do not add. Fingerprints leave both out and apply the equivalences Istanbul
  relies on (see `packages/core/src/fingerprint.ts`), so instrumented code fingerprints like the
  same code without it; over about a thousand real modules, all but a few (optional chains whose
  parentheses Babel's printer drops, which only invalidate more) match unit for unit. A custom
  coverage provider is refused with an explanation.

## Vitest

Vitest runs test files in worker processes or threads, each file in a fresh module registry unless
isolation is off. The capture window opens in Veyrum's setup file, which Veyrum places first, and
closes after the file's tests finish.

- **Code that runs before setup files moves the window earlier.** A Vitest worker runs project
  code before setup files only for a custom environment, snapshot serializers, a diff
  configuration module or a custom runner. A project with any of these starts recording when the
  worker starts, through a `node --import` preload, so reads they make are recorded; projects
  without them skip the preload. Coverage always starts in Veyrum's setup file, so Vitest's own
  start-up runs without it, which is much cheaper (docusaurus, whose snapshot serializers load
  first, went from about twice plain Vitest's time to a fraction more). The modules the runner
  evaluated before coverage started are compared whole, by their source: coverage saw none of
  what they ran while loading.
- **Custom environments are shared inputs.** Vitest loads them through a separate module runner
  whose code V8 cannot attribute to a file. Every module Vitest serves through its `__vitest__`
  environment (custom environments, global setup, the VCS provider) is recorded as a shared input
  by raw source.

## Jest

Jest evaluates every module of a test file inside that file's own vm context, in worker processes
that host many files in turn. The capture window is the file's test environment: Veyrum wraps
each project's configured environment, begins capture in `setup` (before setup files and modules
run) and finishes in `teardown`. Everything else about the environment is the project's own.

Jest-specific observation rules, each covered by `packages/jest/test/hazards.test.ts`:

- **Test code is what Jest compiled into the file's context.** Sources are recorded as Jest
  compiles them (`vm.compileFunction`, `vm.Script`, `vm.SourceTextModule`). Scripts executed in
  the worker's own realm during the window are the runner and its transformers, not test code.
- **Environments are the wrapper's to load.** A `@jest-environment` docblock names a file's
  own environment, which Jest resolves with jest-resolve's `resolveTestEnvironment`. A preload in
  every worker (and in the main process, for files run in band) makes that resolution return the
  wrapper, which loads the named environment itself. Environments, configured or named by a
  docblock, load after the worker's hooks are installed, so their modules are toolchain inputs.
- **The toolchain is a shared input.** Packages the worker loads through Node's own loader
  (transformers, Babel plugins, presets), local files it loads the same way, and the variables the
  worker reads from its own environment (`BABEL_ENV`, CI detection) are shared inputs of the run.
  Tests read their context's copy of `process.env`, which is recorded per file.
- **Module reads by Jest's loader are not file inputs.** Jest's file cache reads each module
  before compiling it. Those reads are dropped for files that were then compiled (their content is
  recorded as a module, by what executed) and kept for everything else, such as JSON modules.
- **Resolution is observed.** Jest resolves modules in the worker through hooked `fs`, so the
  existence checks of resolution are recorded per file.
- **The haste map is not an input; the names looked up in it are.** Jest indexes the repository
  in the main process by reading every file; the main-process recorder is paused while a haste
  map builds. A bare specifier that node_modules resolution cannot find is then looked up by name
  among the repository's package.json files ("haste packages"). Each looked-up name is recorded
  (`pkgname`) with the repository manifests declaring it, over every package.json outside
  node_modules, a superset of what Jest indexes. Jest caches successful resolutions per worker,
  so a cache hit inside a package resolved by name records that name too. A file that resolves a
  haste module (named by `hasteImplModulePath`) is not evidence.
- **A package's own name matters only with `exports`.** Node, Jest and oxc resolve a package's
  imports of itself by name only through its `exports` field, so manifest digests leave the name
  out when there is none. Jest's lookups by name are the `pkgname` entries above.
- **Transformer configuration is shared.** Babel, SWC, Browserslist, TypeScript and Jest
  configuration files are shared inputs, and a new one anywhere is a configuration-like addition.
- **Manual mocks apply by location.** A new file under any `__mocks__` directory is treated as a
  configuration-like addition.
- **Changed modules are re-transformed with the project's own Jest transform**, with the options
  the runtime uses for CommonJS or ECMAScript modules.

## Function source and generated files

- **Reading a function's source pins its module.** When a test reads the source text of a
  function (`Function.prototype.toString`), the text is located in the executed code of the
  modules it loaded, and those modules are compared by raw source (`raw`), so formatting and
  comments in them count. Text found in a dependency needs nothing more, since dependencies are
  compared whole. Text found nowhere (compiled from a string, or more than capture keeps) sets
  the `source-observed` flag, and every module of the file is compared by raw source.
- **What a test creates is not its input.** A file that did not exist when the run started and
  was written by a test (or lies under a directory it created) derives from that test's code,
  and from whatever the test read to produce it, which is recorded. Executing it as a module, or
  the runner's main process reading it afterwards, adds no input.

## Files that run without capture

A full run plans first. A file whose evidence is still valid runs without capture: its closure
is unchanged, so the execution is the one its record describes. If such a file fails, its
failure is stored as a record with that closure, so no later plan reuses the passing record
behind it. Under Jest, files that need capture run first, so a worker ends its coverage session
at most once.

## Environments and skipped files

Under Jest, the preload wraps every environment jest-runner loads, configured or named by a
`@jest-environment` docblock, after Jest has loaded it with the project's own transform: an
environment written in TypeScript or as an ES module is captured like any other, and its files
are inputs of the files that ran in it.

A Vitest file whose tests are all skipped at collection (for example
`describe.skipIf(!process.env.TOKEN)`) runs no file-level hook, so its capture finishes when its
worker stops, and the run waits for every worker before recording. What decided the skip (the
variable, here) is in its closure like any input.

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
6. **Runner-set environment variables.** A variable the runner sets in workers to values that
   differ between files (Vitest's `SSR`, `"1"` in server environments and `""` in DOM
   environments) is not compared: its value follows from the runner's configuration, a shared
   input, and each file's own environment choice, part of its source. A variable every worker
   sees with the same value is compared as usual.
7. **Volatile environment variables.** Variables in the volatile list (CI run identifiers,
   Vitest worker ids, terminal session variables) do not affect outcomes.
8. **Child processes use the C library.** A traced program reads files through the C library's
   exported functions or the `syscall` function. Files the C library reads internally (locale
   data, name service configuration) are system files, covered by the runtime key. A child
   process reads nothing through a descriptor another process opened, except what the test
   itself opened, and a file the test writes after a child read it was not read by the child
   again. The traced child sees the tracer's variables (`LD_PRELOAD`, `VEYRUM_TRACE`,
   `UV_USE_IO_URING=0`) in its environment.
9. **Manifest readers.** Code in the runner's main process, and the known manifest readers in
   workers, use neither the package's own version, dependency version ranges nor scripts from a
   repository manifest. A plugin that did would change what it emits, which the transform-output
   fingerprints observe.
10. **The system temporary directory is scratch space.** What a test reads or lists under
   `os.tmpdir()`, and the listing of that directory itself, are not inputs: tests create their
   own files there, other processes add and remove entries all the time, and a glob crawling
   toward a test's own temporary directory lists it on the way. A repository checked out under
   the temporary directory is still recorded like any other.

The audit (full runs on the main branch, plus sampled re-execution of reused files) is the
backstop for every assumption. Its escape rate is the real safety number.
