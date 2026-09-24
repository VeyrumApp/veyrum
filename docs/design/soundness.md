# Soundness model

Veyrum reuses a passing result for a test file only when every input the file consumed is
unchanged. This document defines what counts as an input, how each one is observed, and what
Veyrum assumes. Every channel listed here has at least one end-to-end scenario in
`packages/vitest/test/hazards-*.test.ts`, `packages/jest/test/hazards.test.ts`,
`packages/mocha/test/hazards.test.ts`, `packages/node-test/test/hazards.test.ts`,
`packages/playwright/test/hazards.test.ts` or, for pytest, `packages/pytest/test/hazards.test.ts`.

## The skip rule

A test file is reused when all of the following hold for some earlier record:

- the record is a pass, and the pass is evidence: no retry was needed, no snapshot was written
  and capture completed;
- the runtime key matches: Node version, platform, architecture, ICU, timezone, locale, Node
  flags, and runner versions (Vitest and Vite, Jest, or Mocha);
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
| `browser-unobserved` | Playwright ran a browser other than Chromium | blocks reuse |
| `server-unobserved` | Playwright traffic reached a local server Veyrum did not observe | blocks reuse |
| `source-observed` | code read function source text that could not be located | compare raw source |
| `positions-observed` | a snapshot embeds source positions | compare raw source |
| `net-local` | loopback connection | allowed |
| `eval` | code compiled from strings | allowed |
| `native-addon` | native module loaded, binary recorded | allowed |
| `env-enumerated` | whole environment read, every variable recorded | allowed |
| `writes-fs` | files written | allowed |

## Child processes

A child process a test starts (`child_process`, including through a shell), and a worker thread
it creates, is traced. How depends on the program and the platform:

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
- **On macOS, through libSystem.** Every program, Go ones included (they call libSystem on
  macOS), gets a library dyld inserts (`packages/capture/native/trace-darwin.c`, through
  `DYLD_INSERT_LIBRARIES`) that interposes libSystem's functions and writes the same log. Because
  interposing rebinds libSystem's calls between its own libraries too, the C library's internal
  file access (`fopen`, `opendir`, `fts`, `glob`, locale files) is seen; a directory counts as
  listed when its entries are read, whatever opened it. The test's child starts through a launcher
  (`packages/capture/native/launch-darwin.c`), so it is handled like any program a traced process
  executes. dyld does not load the library into protected programs: Apple's platform binaries
  (System Integrity Protection removes `DYLD_*` variables for `/bin/sh`, `cat`, `ls` and the rest
  of the system) and programs signed with the hardened runtime without the
  `allow-dyld-environment-variables` and `disable-library-validation` entitlements. Such a program
  runs as a shadow copy: copied into the run's scratch directory once per file version, signed ad
  hoc without the runtime flag, and executed with the arguments and `argv[0]` it would have had;
  a script whose interpreter is protected runs that interpreter's copy, with the arguments the
  kernel would pass. On Apple silicon, system binaries exist only as arm64e, and a machine with
  System Integrity Protection on may refuse ad hoc arm64e programs; the run checks once with a
  copy of `/usr/bin/true`, and where it fails, protected arm64e programs run untraced and block
  reuse, as below. Every library loaded from outside the dyld shared cache is an input too, so a
  program's own dependencies are.

- **Through a DLL (Windows x64).** Every program runs through `veyrum-exec.exe`
  (`packages/capture/native/exec-win.c`), which creates it suspended, adds `veyrum-trace.dll`
  (`packages/capture/native/trace-win.c`, built with Microsoft Detours at a pinned commit) to its
  import table, and passes on the exact command line Node built, so the program sees the
  arguments, `argv[0]`, environment, working directory, streams and window settings it would
  have. The DLL hooks the ntdll functions every Win32 and C runtime file function ends up in
  (`NtCreateFile` and `NtOpenFile`, read or write by the access and disposition asked for; the
  attribute queries; directory queries, a listing or a check of the one name queried; renames,
  links, deletions and reparse points), process creation in `CreateProcessInternalW`, where every
  `CreateProcess` variant meets (a new process starts suspended, gets the DLL, and keeps
  `VEYRUM_TRACE`), and Winsock connections, and writes the same log. A relative path is recorded
  against the working directory as the program set it. The test sees the launcher's pid and the
  program's exit code; terminating the launcher ends the program (a job object), not what the
  program started, as when Node starts a program directly. A shell (`shell` option, `exec`) is
  started the same way, with the command line Node would have given it.

- **Through capture's own hooks.** Where no native tracer follows it (another platform, or with
  `VEYRUM_NATIVE_TRACING=off`), a program that is the test's own Node binary, or a script whose
  `#!` line runs it, starts with a preload (`packages/capture/src/child.ts`) that installs the same
  hooks as the test's worker and logs what the program reads, lists, writes, starts and connects
  to, and every module it loads (its code is an input file by file). Its own Node children are
  traced the same way. Like the test's own code, a native addon's file access is not seen (the
  addon's binary is recorded). A worker thread gets the same preload on every platform, and its
  whole environment is an input; one that shares the test's environment (`SHARE_ENV`) cannot get
  it, and blocks reuse.

The test file's closure gets what its children did like its own reads. On top of that:

- **The program and its lookup are inputs.** The executed file's content, and the absence of the
  program in PATH directories searched before it.
- **The whole inherited environment is an input.** A shell imports every variable at startup,
  so each variable the child receives from the test's environment is recorded, not just those it
  reads. A value the call sets itself (`spawn(cmd, { env: { ...process.env, TZ: 'UTC' } })`) comes
  from the test's code, which is recorded already.
- **Descendants stay traced.** Every exec restores the preloaded tracer's variables, even when a
  program clears its environment for its own children; under ptrace, every descendant is followed
  by the tracer itself; on Windows, every process a traced one creates gets the DLL before its
  first instruction runs.
- **Anything else blocks reuse.** A program for another machine or a 32-bit one, a raw `execve`
  system call or `fexecve` from a dynamically linked program, `glob`, `ftw` and `nftw` (which read
  directories internally), system calls of another architecture, `io_uring`, `open_by_handle_at`,
  and a statically linked shell started through a `shell` option are reported as untraceable, and
  the check gets the `spawn` flag. On macOS, so are a set-user-ID program, one with a `__RESTRICT`
  segment, a protected program that loads libraries relative to its own file (`@executable_path`,
  `@loader_path`) or is an application's executable (a copy would not run as the original does),
  a protected program whose shadow copy cannot be made or run, a file opened by its
  file-system identifiers (`openbyid_np`) and an exec through `syscall()`; system calls made
  without libSystem are not seen, which macOS does not support as an interface.
  On Windows, so are a program the DLL cannot be loaded into (a 32-bit one), a process created
  below `CreateProcessInternalW` (`NtCreateUserProcess` called directly), a file opened by its ID,
  and a path with no Win32 name (a volume without a drive letter).

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

## Mocha

Mocha runs every file in one process, so Veyrum runs each selected file in a process of its own,
through the project's Mocha command line with its configuration (`.mocharc.*`, the `mocha` key of
`package.json`, `MOCHA_OPTIONS`) and that file as the only spec. Capture begins before Mocha loads
and finishes when the process is idle, or before Mocha's own `--exit`; a file whose run never ends
fails. Discovery is Mocha's own file lookup. Configuration files and the root manifest are shared
inputs, and what each process reads while loading them is its file's input. `--require` modules,
root hook plugins and global fixtures run in every file's process, so they are that file's inputs
and see only that file, as they would in Mocha's parallel mode. Node's loaders read a module's
file to compile it: those reads are the module, recorded by what executed, while a test's own read
of a module file records the file whole (`packages/mocha/test/hazards.test.ts`).

## pytest

pytest runs each test file in its own `python -m pytest <file>` process (Python 3.12 or later),
several at once, so no state carries over between files. The configuration file and root
directory are those pytest picks for the whole suite (`--collect-only` finds both), passed to
every process. A plugin (`packages/pytest/src/python/veyrum_capture.py`) loads before any
conftest.py and records the file's closure until the process exits. Scenarios are in
`packages/pytest/test/hazards.test.ts`.

What is observed:

- **Code, by unit.** Every code object that starts (`sys.monitoring` PY_START, switched off for a
  code object after its first start) is mapped to a unit of its source file: the module top level,
  functions, methods, lambdas, generator expressions and class bodies, named as in fingerprint.ts
  (`class:` for class bodies). A unit is fingerprinted on its `ast` with positions left out and
  nested units reduced to what the enclosing scope evaluates (name, parameters with defaults and
  annotations, decorators; a class's bases), so formatting and comments never count and
  docstrings do. Code a source file does not explain (compiled from a string under its name) makes
  the module compare by raw source, and so does a test file that ran doctests. conftest.py files
  are code like any other; a new one is a configuration-like addition for the files below it, and
  so is a new pytest configuration file.
- **Files, directories, environment.** An audit hook sees `open` (reads and writes by mode),
  `os.listdir` and `os.scandir`; wrappers of `os.stat` and `os.lstat` see existence checks
  (`os.path.exists`, `Path.is_file`); `os.environ` records each variable read, and enumeration.
  Reads by the import system and by pytest's assertion rewriter are code, recorded as code.
  pytest's own reads of the environment are shared inputs of the run, and its checks inside
  directories next to the test file's ancestors (virtual environment and package detection while
  collecting) are left out: they only classify nodes it does not collect.
- **Imports, including how they resolved.** A module found in the repository is code; any other
  file loaded as a module (site-packages, a C extension) is a whole-file input, and the packages
  pytest loaded before the plugin are shared inputs. For each import, the absence of the module's
  names (package directory, extension module, source file) in every earlier entry of its search
  path is an input, so a new file that would shadow it reruns the files that imported it. The
  standard library is covered by the runtime key: the Python version, implementation and
  platform, pytest's version and Python's own environment variables.
- **Python child processes.** A process a test starts through `subprocess` that runs the same
  interpreter, named by path (`sys.executable`), gets the plugin too (through a `sitecustomize`
  on its `PYTHONPATH`), and its closure joins the test file's. Variables the test set for it are
  the test's own code. A traced child that leaves no payload (started with `-S` or `-I`, killed,
  or still running when the file ends), any other program, and processes started without
  `subprocess` (`os.system`, `os.fork`, multiprocessing) set the `spawn` flag. Network
  connections and `ctypes` libraries are recorded as for Node.

What is not observed: file access inside C extensions and other native code (as with Node's native
addons, the binary is recorded, not what it reads), existence checks Python makes without
`os.stat` (the native `os.path` checks on Windows), reads through file descriptors the test did not
open by path, and line numbers, which a test can observe through tracebacks or `inspect` without
reading its source. Reading a source file does record it, in full.

## Playwright

An end-to-end test file runs in three places: its own Node process, the browser, and the app
server. Each is observed separately, and a check is one test file under one Playwright project.

- **One worker process per test group.** Playwright reuses a worker for the next file of the same
  project; a worker that already ran a group answers the next one as done without running it, and
  Playwright runs it in a fresh worker, as it does after a failure. The worker is captured like a
  `node --test` process, from the moment its group arrives until it exits (worker fixtures torn
  down). Browsers it launches are inputs by their executable; their own reads are not traced.
- **Test-process modules are compiled code.** Playwright compiles every module of the test
  process outside node_modules (specs, helpers, page objects, the configuration) with Babel, and
  capture records the code V8 compiled, not the file. After the run, Veyrum runs Playwright's own
  transform (`babelTransform` from the project's installed `playwright` package) on each module's
  source, with the arguments Playwright passes: the module format Playwright decides for the file
  (its extension, else the nearest package.json's `type`), the `playwright` package as the JSX
  import source, and no component-testing plugin. A module whose compiled code this reproduces
  byte for byte is recorded by the functions that ran, and a changed one is compiled the same way
  at plan time, so editing a function reruns only the files that ran it. Any other module is
  compared by its source: one Playwright left uncompiled (`build.external`), loaded in another
  format (required although its package is a module), served from Playwright's compile cache
  with output the transform no longer produces, changed since the run, or any module at all under
  component testing (`PW_TEST_SOURCE_TRANSFORM`). At plan time, a module that cannot be compiled
  again (Playwright's internals not found or not the shape this adapter knows, a Babel error,
  component testing) runs its files. Playwright's load hook reads each module's file to compile
  it; that read is the module itself, recorded by what ran. A file both the test process and a
  page ran is compared by its source, since the two compile it differently.
- **The browser, through Chromium's coverage.** Every page gets its own DevTools session, and
  `context.newPage()` returns only once that page's precise coverage has started. Every request
  is recorded where it went (the URL, or the loopback address a name resolved to), and the body of
  every local response is digested, except images, media and fonts, which stay server inputs;
  requests a route handler answered or aborted never reached the network.
- **Client files.** A repository file the app server read and some browser received byte for
  byte (and no other file the server read has the same content) is a client file: an input only
  of the test files whose browsers received it, not of every file that talked to the server. A client file the pages ran as a script, with every run of it covered, is a `mod`
  entry with the functions the pages ran; anything else (a document, data, a script that ran
  before coverage started, or any page with a worker, a cross-site frame, a lost renderer or a
  page closed before its coverage was taken) makes it a whole-file input. A server that loaded
  the file as code, or wrote it, keeps it a server input. Scripts the server generated or
  transformed (a bundler's output, a dev server's modules) derive from what the server read, which
  counts whole for every file that talked to it; source maps are not used, since attributing a
  bundle's sources to single test files would miss sources the server also rendered or bundled.
- **The app server.** The programs Playwright's `webServer` starts run under the native tracer
  (Linux), and every Node process among them logs the ports it listens on and the files it loads
  as code. Everything they read during the whole run, with their environment, is an input of every
  test file that talked to one of those ports, from a page or from the test process. A test
  process that talked to the server may read anything it sends, so every client file is a
  whole-file input of that test file.
- **Programs global setup starts** (any program the project's own code starts in the main
  process) run traced the same way, and what they read is an input of every test file; one that
  cannot be traced sets `spawn` for every file. A server one of them starts logs its ports too.
- **A server a test starts** is the test's child process, traced with it; the ports it listens
  on count as the test's own.
- **Traffic Veyrum cannot attribute blocks reuse.** A request or connection, from a page or the
  test process, to a local port that no observed program listened on (a server that is not a Node program, such as Python, Go or a container;
  one already running; one started some other way) sets `server-unobserved`, and so does a
  server that could not be traced (no native tracer on this platform, or
  `VEYRUM_NATIVE_TRACING=off`). Remote requests set
  `net-remote` (`--allow net` allows them). Firefox and WebKit set `browser-unobserved`: their
  pages cannot be covered.
- **The main process.** Configuration files are shared inputs, and so is everything Playwright's
  main process reads outside the loading of test files (global setup and its imports, environment
  files); what loading test files reads, each file's worker reads again for itself. Browsers
  global setup drives are followed for where they connect: remote requests block every file, and
  talking to the app server makes every file a talker with all client files whole.
- **Runtime.** The runtime key includes the Playwright version and the browser builds it drives;
  each file's closure includes the browser executables it launched.

Not observed: what a browser does beyond running its pages' JavaScript (layout, rendering), the
state of services the server talks to over loopback (a database), and what a server does with a
client file besides sending it (assumption 11).

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
5. **Benign source readers.** Vitest's and Playwright's own reading of test callback and
   fixture function source (fixture detection, which uses only the parameter list) is treated as
   benign.
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
   `UV_USE_IO_URING=0`) in its environment. On Windows, a traced program reaches files through
   ntdll (Windows system call numbers change between releases, so programs do not make system
   calls themselves), the DLLs it links against, loaded before the tracer starts like the
   libraries the dynamic loader maps on Linux, are system files or change with the program, and
   it sees `VEYRUM_TRACE` in its environment.
9. **Manifest readers.** Code in the runner's main process, and the known manifest readers in
   workers, use neither the package's own version, dependency version ranges nor scripts from a
   repository manifest. A plugin that did would change what it emits, which the transform-output
   fingerprints observe.
10. **The system temporary directory is scratch space.** What a test reads or lists under
   `os.tmpdir()`, and the listing of that directory itself, are not inputs: tests create their
   own files there, other processes add and remove entries all the time, and a glob crawling
   toward a test's own temporary directory lists it on the way. A repository checked out under
   the temporary directory is still recorded like any other.
11. **Client files are content.** A file a Playwright app server sends byte for byte, and neither
   loads as code nor writes, affects a test only through what the browser does with it. A server
   that also derives other responses from such a file (a count of the records in a JSON file it
   also serves as is) could change a test whose browser never received the file.

The audit (full runs on the main branch, plus sampled re-execution of reused files) is the
backstop for every assumption. Its escape rate is the real safety number.
