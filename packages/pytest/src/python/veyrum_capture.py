"""Veyrum's pytest plugin, loaded with ``-p veyrum_capture`` into every pytest process Veyrum starts.

Veyrum runs each test file in its own ``python -m pytest <file>`` process. In that process this
plugin records what the file consumed and writes it as a payload for capture's assemble step:

- code: every code object that starts (sys.monitoring PY_START, disabled after its first start),
  mapped to the units of its source file (see veyrum_fingerprint);
- files read, written, checked (``os.stat``/``os.lstat``) and listed, through an audit hook and
  wrappers of ``os.stat`` and ``os.lstat``;
- environment variables read, through the class of ``os.environ``;
- modules loaded from outside the repository (whole files), and how each import was resolved;
- child processes, network connections and native libraries, which the planner treats as
  channels it cannot see into.

It also reports each test's outcome, and in collect mode which test files pytest would run.
Configuration comes from the VEYRUM_PYTEST_CAPTURE variable, which the plugin removes, together
with its own PYTHONPATH entry, before any test code runs.
"""

import atexit
import json
import os
import re
import stat as _stat
import sys
import sysconfig
import tempfile
import threading
import time
from importlib.machinery import EXTENSION_SUFFIXES

import veyrum_fingerprint as _fp

CONFIG_ENV = 'VEYRUM_PYTEST_CAPTURE'
# Variables pytest sets for the tests it runs, from the test's own identity and pytest's version.
_RUNNER_ENV = re.compile(r'^PYTEST_(CURRENT_TEST|VERSION)$')
_FROZEN_EXTERNAL = '<frozen importlib._bootstrap_external>'
_PYCACHE = f'{os.sep}__pycache__{os.sep}'
_PYCACHE_DIR = f'{os.sep}__pycache__'
_INSTALLED = (f'{os.sep}site-packages{os.sep}', f'{os.sep}dist-packages{os.sep}')


def _installed(p):
    """Whether a path is inside an installation directory of packages."""
    return _INSTALLED[0] in p or _INSTALLED[1] in p


def _load_config():
    raw = os.environ.pop(CONFIG_ENV, None)
    if raw is None:
        return None
    config = json.loads(raw)
    # The tests see the environment and import path they would see without Veyrum.
    original = config.get('pythonPath')
    if original is None:
        os.environ.pop('PYTHONPATH', None)
    else:
        os.environ['PYTHONPATH'] = original
    plugin_dir = config['pluginDir']
    sys.path[:] = [p for p in sys.path if os.path.abspath(p or os.curdir) != plugin_dir]
    return config


_config = _load_config()
_real_stat = os.stat
_real_lstat = os.lstat


def _type_of(path):
    """The type of a path as the planner sees it (following symbolic links)."""
    try:
        mode = _real_stat(path).st_mode
    except (OSError, ValueError):
        return 'absent'
    return 'file' if _stat.S_ISREG(mode) else 'dir' if _stat.S_ISDIR(mode) else 'other'


def _prefixes(*dirs):
    out = set()
    for d in dirs:
        if not d:
            continue
        out.add(os.path.join(os.path.abspath(d), ''))
        out.add(os.path.join(os.path.realpath(d), ''))
    return tuple(sorted(out))


def _package_dir(name):
    module = sys.modules.get(name)
    f = getattr(module, '__file__', None)
    return os.path.dirname(os.path.abspath(f)) if f else None


def _caller(depth):
    """What `sys._getframe(depth)` gives the function calling this one, or None past the bottom."""
    try:
        return sys._getframe(depth + 1)
    except ValueError:
        return None


def _digest_env(value):
    return _fp.digest(f'env\n{value}')


class _Capture:
    def __init__(self, config):
        self.started = time.perf_counter()
        self.pid = os.getpid()
        self.root = config['root']
        self.root_prefix = os.path.join(self.root, '')
        self.ignored = tuple(config['ignored'])
        self.payload_file = config['payload']
        self.test_file = config['testFile']
        self.volatile = re.compile(config['volatileEnv'])
        # The standard library of the base installation (in a virtual environment, `platstdlib`
        # is the environment's own lib directory, which holds site-packages).
        self.stdlib = _prefixes(os.path.dirname(os.__file__), sysconfig.get_path('stdlib'))
        self.installs = _prefixes(sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix)
        self.temp = _prefixes(tempfile.gettempdir())
        self.runner = _prefixes(_package_dir('_pytest'), _package_dir('pluggy'), _package_dir('pytest'))
        rewrite = sys.modules.get('_pytest.assertion.rewrite')
        self.rewrite_file = getattr(rewrite, '__file__', None)
        # Modules loaded before capture began: the runner and its dependencies.
        self.preloaded = set()
        for module in list(sys.modules.values()):
            f = getattr(module, '__file__', None)
            if isinstance(f, str):
                self.preloaded.add(os.path.abspath(f))

        self.active = True
        self.paths = {}
        # Checks pytest made itself, kept only where they concern the test file (see payload).
        self.runner_stats = {}
        self.writes = set()
        self.env = {}
        self.toolchain_env = {}
        self.env_written = set()
        self.env_enumerated = False
        self.net = []
        self.spawns = []
        self.dlopen = set()
        self.imports = {}
        self.codes = set()
        self.errors = []
        self.last_path = None
        # Python child processes: where they write payloads, and those this process started
        # traced (child id to the program and the variables the test set for it).
        self.config = config
        self.children_dir = config['children']
        self.child_id = config.get('childId')
        self.injected = {}
        self.local = threading.local()
        self.env_baseline = {
            n: _digest_env(v) for n, v in os.environ.items() if not self.volatile_env(n)
        }

    # --- classification -------------------------------------------------------------------

    def volatile_env(self, name):
        return bool(self.volatile.match(name) or _RUNNER_ENV.match(name))

    def in_stdlib(self, p):
        return p.startswith(self.stdlib) and not _installed(p)

    def skipped(self, p):
        """
        Paths never recorded: Veyrum's own files, Python's bytecode caches, the null device, and
        temporary files outside the repository.
        """
        if p.startswith(self.ignored) or p == os.devnull or _PYCACHE in p or p.endswith(_PYCACHE_DIR):
            return True
        if p.startswith(self.root_prefix):
            return False
        return p.startswith(self.temp) or p + os.sep in self.temp

    def repo_code(self, p):
        """A Python source file of the repository, whose code is fingerprinted by units."""
        return (
            p.endswith('.py')
            and p.startswith(self.root_prefix)
            and not p.startswith(self.ignored)
            and not p.startswith(self.installs)
            and not _installed(p)
        )

    def origin(self, frame):
        """The innermost calling frame outside the standard library, if any."""
        while frame is not None:
            name = frame.f_code.co_filename
            if not (name.startswith('<frozen') or self.in_stdlib(name)):
                return frame
            frame = frame.f_back
        return None

    def by_runner(self, frame):
        origin = self.origin(frame)
        return origin is not None and origin.f_code.co_filename.startswith(self.runner)

    def code_load(self, frame):
        """
        An open by the import system, pytest's assertion rewriter or the interpreter itself (the
        main script): code, recorded as code.
        """
        if frame is None:
            return True
        code = frame.f_code
        if code.co_filename == '<frozen zipimport>':
            # Whether a path is a zip archive of modules (the main script is checked too).
            return True
        if code.co_filename == _FROZEN_EXTERNAL and code.co_name == 'get_data':
            back = frame.f_back
            return back is not None and back.f_code.co_name == 'get_code'
        origin = self.origin(frame)
        return (
            origin is not None
            and origin.f_code.co_filename == self.rewrite_file
            and origin.f_code.co_name in ('_rewrite_test', '_read_pyc')
        )

    @staticmethod
    def absolute(path):
        if path is None:
            return os.getcwd()
        if isinstance(path, int):
            return None
        p = os.fsdecode(os.fspath(path))
        return os.path.normpath(p if os.path.isabs(p) else os.path.join(os.getcwd(), p))

    # --- observations ---------------------------------------------------------------------

    def note(self, p, kind, type_=None):
        key = (p, kind)
        if key not in self.paths:
            self.paths[key] = type_ if type_ is not None else _type_of(p)

    def note_stat(self, path, dir_fd, result):
        if not self.active or dir_fd is not None:
            return
        try:
            p = self.absolute(path)
            if p is None or self.skipped(p):
                return
            if result is None:
                type_ = 'absent'
            elif _stat.S_ISLNK(result.st_mode):
                type_ = _type_of(p)
            else:
                mode = result.st_mode
                type_ = 'file' if _stat.S_ISREG(mode) else 'dir' if _stat.S_ISDIR(mode) else 'other'
            if self.by_runner(_caller(2)):
                self.runner_stats.setdefault(p, type_)
            else:
                self.note(p, 'stat', type_)
        except Exception as error:  # capture must never break the test
            self.errors.append(f'stat: {error!r}')

    def env_read(self, name, value, frame):
        if not self.active or not isinstance(name, str) or name in self.env_written:
            return
        if self.volatile_env(name):
            return
        target = self.toolchain_env if self.by_runner(frame) else self.env
        if name not in target:
            target[name] = None if value is None else _digest_env(value)

    def audit(self, event, args):
        if not self.active:
            return
        handler = _HANDLERS.get(event)
        if handler is None:
            return
        try:
            try:
                frame = sys._getframe(1)
            except ValueError:
                # No Python frame: the interpreter itself (loading the main script).
                frame = None
            handler(self, args, frame)
        except Exception as error:  # capture must never break the test
            self.errors.append(f'{event}: {error!r}')

    def on_open(self, args, frame):
        path, mode, flags = args
        p = self.absolute(path)
        if p is None or self.skipped(p):
            return
        if isinstance(flags, int) and flags >= 0:
            access = flags & os.O_ACCMODE
            reading = access in (os.O_RDONLY, os.O_RDWR)
            writing = access != os.O_RDONLY or bool(flags & (os.O_CREAT | os.O_TRUNC | os.O_APPEND))
        else:
            m = mode if isinstance(mode, str) else 'r'
            writing = any(c in m for c in 'wax+')
            reading = 'r' in m or '+' in m
        if writing:
            self.writes.add(p)
        if reading and not self.code_load(frame):
            self.note(p, 'read')

    def on_list(self, args, frame):
        path = args[0] if args else None
        if frame is not None and frame.f_code.co_filename.startswith('<frozen importlib'):
            # Module lookups: recorded precisely, per import (see import_stats).
            return
        if self.by_runner(frame):
            # pytest listing directories to discover test files; the file to run is named.
            return
        p = self.absolute(path)
        if p is not None and not self.skipped(p):
            self.note(p, 'dir')

    def on_connect(self, args, frame):
        sock, address = args[0], args[1]
        socket = sys.modules['socket']
        if getattr(socket, 'AF_UNIX', None) is not None and sock.family == socket.AF_UNIX:
            host = os.fsdecode(address) if isinstance(address, (str, bytes)) else str(address)
            self.net.append({'host': host, 'port': None, 'local': True})
            return
        if not isinstance(address, tuple) or not address:
            return
        host = str(address[0])
        port = address[1] if len(address) > 1 and isinstance(address[1], int) else None
        self.net.append({'host': host, 'port': port, 'local': _loopback(host)})

    def on_dlopen(self, args, frame):
        name = args[0] if args else None
        if isinstance(name, (str, bytes)):
            p = os.fsdecode(name)
            if os.path.isabs(p):
                self.dlopen.add(os.path.normpath(p))

    def on_import(self, args, frame):
        module, filename, path = args[0], args[1], args[2]
        if filename is not None or module in self.imports or not isinstance(path, list):
            return
        snapshot = self.last_path
        if snapshot is None or list(snapshot) != path:
            snapshot = tuple(path)
            self.last_path = snapshot
        self.imports[module] = snapshot

    # --- the payload ----------------------------------------------------------------------

    def finish(self):
        if not self.active or os.getpid() != self.pid:
            return
        self.active = False
        finish_started = time.perf_counter()
        try:
            payload = self.payload(finish_started)
        except Exception as error:  # a failure only loses this file's evidence
            self.errors.append(f'finish: {error!r}')
            payload = self.minimal_payload()
        tmp = f'{self.payload_file}.{os.getpid()}.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(payload, f)
        os.replace(tmp, self.payload_file)

    def minimal_payload(self):
        return {
            'version': 1,
            'testFile': self.test_file,
            'pid': self.pid,
            'threadId': 0,
            'isolateReused': False,
            'modules': [],
            'natives': [],
            'paths': [],
            'writes': [],
            'env': [],
            'envBaseline': {},
            'toolchainEnv': [],
            'envEnumerated': False,
            'envWritten': [],
            'net': [],
            'spawns': [],
            'dlopen': [],
            'evalScripts': 0,
            'sourceObserved': False,
            'snapshot': {'added': 0, 'updated': 0},
            'toolchain': [],
            'toolchainFiles': [],
            'captureErrors': list(self.errors),
        }

    def payload(self, finish_started):
        _stop_monitoring()
        by_file = {}
        for code in self.codes:
            by_file.setdefault(code.co_filename, []).append(code)

        modules = []
        whole = []
        executed = set()
        eval_scripts = 0
        for filename, codes in sorted(by_file.items()):
            if filename.startswith('<'):
                if not filename.startswith('<frozen'):
                    eval_scripts += 1
                if filename.startswith('<doctest '):
                    # Doctest examples come from docstrings, which only count in the units of the
                    # functions they document: the test file is compared by raw source.
                    whole.append(self.test_file)
                continue
            p = os.path.abspath(filename)
            if not self.repo_code(p):
                continue
            executed.add(p)
            if p in self.preloaded:
                whole.append(p)
                continue
            try:
                with open(p, 'rb') as f:
                    source = f.read()
            except OSError:
                whole.append(p)
                continue
            m = _fp.analyze(source, self.root)
            top = _fp.OPAQUE_UNIT if m.opaque else _fp.TOP_UNIT
            units = {top: m.units[top]}
            located = True
            for code in codes:
                found = m.locate(code.co_qualname, code.co_firstlineno)
                if found is None:
                    located = False
                    break
                for unit in found:
                    units[unit] = m.units[unit]
            if not located:
                # Code this source does not explain (compiled from a string under the module's
                # name, or a construct without a unit): the module is compared by raw source.
                whole.append(p)
                continue
            src = _fp.digest_bytes(source)
            modules.append({'path': p, 'code': src, 'executed': [], 'units': units, 'src': src})

        natives = []
        toolchain = []
        for module in list(sys.modules.values()):
            f = getattr(module, '__file__', None)
            if not isinstance(f, str):
                continue
            p = os.path.abspath(f)
            if self.repo_code(p):
                if p not in executed:
                    whole.append(p)
                continue
            if self.in_stdlib(p) or p.startswith(self.ignored):
                continue
            if p in self.preloaded:
                toolchain.append(p)
            else:
                natives.append(p)
            if p.endswith(tuple(EXTENSION_SUFFIXES)):
                self.dlopen.add(p)

        self.import_stats()
        self.runner_checks()
        if self.child_id is None:
            eval_scripts += self.merge_children(modules, whole, natives, toolchain)
        paths = [{'p': p, 'kind': kind, 'type': t} for (p, kind), t in sorted(self.paths.items())]
        env_names = set(self.env)
        payload = {
            'version': 1,
            'testFile': self.test_file,
            'pid': self.pid,
            'threadId': 0,
            'isolateReused': False,
            'modules': modules,
            'natives': sorted(set(natives)),
            'wholeModules': sorted(set(whole)),
            'paths': paths,
            'writes': sorted(self.writes),
            'env': [{'n': n, 'h': self.env[n]} for n in sorted(env_names)],
            'envBaseline': self.env_baseline,
            'toolchainEnv': [
                {'n': n, 'h': h} for n, h in sorted(self.toolchain_env.items()) if n not in env_names
            ],
            'envEnumerated': self.env_enumerated,
            'envWritten': sorted(self.env_written),
            'net': self.net,
            'spawns': self.spawns,
            'dlopen': sorted(self.dlopen),
            'evalScripts': eval_scripts,
            'sourceObserved': False,
            'snapshot': {'added': 0, 'updated': 0},
            'toolchain': sorted(set(toolchain)),
            'toolchainFiles': [],
            'captureErrors': list(self.errors),
            'timings': {
                'beginMs': 0,
                'finishMs': (time.perf_counter() - finish_started) * 1000,
            },
        }
        if self.child_id is not None:
            payload['childId'] = self.child_id
            payload['injected'] = self.injected
        return payload

    def merge_children(self, modules, whole, natives, toolchain):
        """
        Adds what traced Python child processes (and theirs) consumed, as if this process had. A
        child that was started traced but left no payload (it exited abruptly, or still runs)
        counts as an untraced child process. Returns the children's count of compiled strings.
        """
        expected = dict(self.injected)
        payloads = {}
        try:
            names = sorted(os.listdir(self.children_dir))
        except OSError:
            names = []
        for name in names:
            if not name.endswith('.json'):
                continue
            try:
                with open(os.path.join(self.children_dir, name), encoding='utf-8') as f:
                    child = json.load(f)
            except (OSError, ValueError) as error:
                self.errors.append(f'child payload {name}: {error!r}')
                continue
            payloads[child['childId']] = child
            expected.update(child.get('injected', {}))
        by_path = {m['path']: m for m in modules}
        eval_scripts = 0
        for child_id, spawn in sorted(expected.items()):
            child = payloads.get(child_id)
            if child is None:
                self.spawns.append(spawn['program'])
                continue
            for m in child['modules']:
                own = by_path.get(m['path'])
                if own is None:
                    by_path[m['path']] = m
                    modules.append(m)
                elif own['src'] != m['src']:
                    whole.append(m['path'])
                else:
                    own['units'].update(m['units'])
            whole.extend(child.get('wholeModules', []))
            natives.extend(child['natives'])
            toolchain.extend(child['toolchain'])
            for entry in child['paths']:
                self.note(entry['p'], entry['kind'], entry['type'])
            self.writes.update(child['writes'])
            # A variable the test set for the child comes from the test's own code.
            given = set(spawn['overridden']) | self.env_written
            for e in child['env']:
                if e['n'] not in given:
                    self.env.setdefault(e['n'], e['h'])
            for e in child['toolchainEnv']:
                if e['n'] not in given:
                    self.toolchain_env.setdefault(e['n'], e['h'])
            self.env_enumerated = self.env_enumerated or child['envEnumerated']
            self.net.extend(child['net'])
            self.spawns.extend(child['spawns'])
            self.dlopen.update(child['dlopen'])
            self.errors.extend(child['captureErrors'])
            eval_scripts += child['evalScripts']
        return eval_scripts

    def runner_checks(self):
        """
        pytest checks paths to find configuration, conftest.py files and packages above the test
        file, and to classify every directory it passes while collecting (virtual environments,
        packages). Only the first kind concerns the file it runs: the directories above it and the
        files in them. Checks inside sibling directories only decide how nodes that are not
        collected would be.
        """
        ancestors = set()
        d = os.path.dirname(self.test_file)
        while True:
            ancestors.add(d)
            parent = os.path.dirname(d)
            if parent == d:
                break
            d = parent
        for p, type_ in self.runner_stats.items():
            if p in ancestors or (os.path.dirname(p) in ancestors and type_ != 'dir'):
                self.note(p, 'stat', type_)

    def import_stats(self):
        """
        How each import resolved. A module is found in the first entry of its search path that has
        it, as a package directory, an extension module or a source file (in that order), so the
        absence of those names in every earlier entry is an input, and so is the absence of a
        package or extension module of the same name next to it. An import that failed depends on
        the absence of the module everywhere.
        """
        cwd = os.getcwd()
        for name, snapshot in self.imports.items():
            parent, _, tail = name.rpartition('.')
            if parent:
                search = list(getattr(sys.modules.get(parent), '__path__', None) or [])
            else:
                search = list(snapshot)
            module = sys.modules.get(name)
            spec = getattr(module, '__spec__', None)
            origin = getattr(spec, 'origin', None)
            if origin in ('built-in', 'frozen'):
                continue
            found_dir = None
            package = False
            if spec is not None and getattr(spec, 'has_location', False) and isinstance(origin, str):
                package = spec.submodule_search_locations is not None
                found_dir = os.path.dirname(os.path.dirname(origin) if package else origin)
            for entry in search:
                if not isinstance(entry, str):
                    continue
                e = os.path.normpath(os.path.join(cwd, entry)) if entry else cwd
                ep = os.path.join(e, '')
                # A submodule of an installed package resolves inside that package, whose files
                # change only when it is reinstalled (its loaded files are inputs already).
                if self.in_stdlib(ep) or self.skipped(e) or (parent and _installed(ep)):
                    continue
                base = os.path.join(e, tail)
                here = found_dir is not None and os.path.normpath(found_dir) == e
                for suffix in EXTENSION_SUFFIXES:
                    self.note(base + suffix, 'stat')
                if here:
                    if not package:
                        self.note(base, 'stat')
                        self.note(os.path.join(base, '__init__.py'), 'stat')
                    break
                self.note(base, 'stat')
                self.note(os.path.join(base, '__init__.py'), 'stat')
                self.note(base + '.py', 'stat')


def _loopback(host):
    if host in ('localhost', 'ip6-localhost', 'ip6-loopback'):
        return True
    try:
        import ipaddress

        return ipaddress.ip_address(host.split('%')[0]).is_loopback
    except ValueError:
        return False


def _on_write(*indices):
    """A handler recording the paths at these argument positions as written."""

    def handler(capture, args, frame):
        for i in indices:
            if i < len(args) and args[i] is not None and not isinstance(args[i], int):
                p = capture.absolute(args[i])
                if p is not None and not capture.skipped(p):
                    capture.writes.add(p)

    return handler


def _on_spawn(index):
    """A handler recording a started program (the argument at `index`, or the first of argv)."""

    def handler(capture, args, frame):
        if getattr(capture.local, 'traced', False):
            # A Python child started with capture (see _install_spawn): it reports itself.
            return
        program = args[index] if index is not None and index < len(args) else None
        if program is None and len(args) > 1:
            argv = args[1]
            program = argv[0] if isinstance(argv, (list, tuple)) and argv else argv
        if isinstance(program, (list, tuple)):
            program = program[0] if program else None
        if isinstance(program, bytes):
            program = os.fsdecode(program)
        capture.spawns.append('fork' if program is None else str(program))

    return handler


_HANDLERS = {
    'open': _Capture.on_open,
    'os.listdir': _Capture.on_list,
    'os.scandir': _Capture.on_list,
    'os.mkdir': _on_write(0),
    'os.rmdir': _on_write(0),
    'os.remove': _on_write(0),
    'os.rename': _on_write(0, 1),
    'os.link': _on_write(1),
    'os.symlink': _on_write(1),
    'os.truncate': _on_write(0),
    'os.utime': _on_write(0),
    'os.chmod': _on_write(0),
    'shutil.copyfile': _on_write(1),
    'shutil.copytree': _on_write(1),
    'shutil.rmtree': _on_write(0),
    'subprocess.Popen': _on_spawn(0),
    'os.system': _on_spawn(0),
    'os.exec': _on_spawn(0),
    'os.posix_spawn': _on_spawn(0),
    'os.spawn': _on_spawn(1),
    'os.fork': _on_spawn(None),
    'os.forkpty': _on_spawn(None),
    'os.startfile': _on_spawn(0),
    'socket.connect': _Capture.on_connect,
    'socket.sendto': _Capture.on_connect,
    'ctypes.dlopen': _Capture.on_dlopen,
    'import': _Capture.on_import,
}

_capture = None
_tool = None


def _start_monitoring(capture):
    global _tool
    monitoring = sys.monitoring
    for tool in (3, 4, 2):
        try:
            monitoring.use_tool_id(tool, 'veyrum')
        except ValueError:
            continue
        _tool = tool
        break
    else:
        capture.errors.append('no free sys.monitoring tool id')
        return
    add = capture.codes.add
    disable = monitoring.DISABLE

    def on_start(code, offset):
        add(code)
        return disable

    monitoring.register_callback(_tool, monitoring.events.PY_START, on_start)
    monitoring.set_events(_tool, monitoring.events.PY_START)


def _stop_monitoring():
    global _tool
    if _tool is None:
        return
    monitoring = sys.monitoring
    monitoring.set_events(_tool, 0)
    monitoring.register_callback(_tool, monitoring.events.PY_START, None)
    monitoring.free_tool_id(_tool)
    _tool = None


def _install_environ(capture):
    """Records reads of os.environ (and os.environb) by changing the class of the one object."""
    base = type(os.environ)

    class RecordingEnviron(base):
        def __getitem__(self, key):
            try:
                value = base.__getitem__(self, key)
            except KeyError:
                capture.env_read(_env_name(key), None, _caller(1))
                raise
            text = os.fsdecode(value) if isinstance(value, bytes) else value
            capture.env_read(_env_name(key), text, _caller(1))
            return value

        def __setitem__(self, key, value):
            capture.env_written.add(_env_name(key))
            base.__setitem__(self, key, value)

        def __delitem__(self, key):
            capture.env_written.add(_env_name(key))
            base.__delitem__(self, key)

        def __iter__(self):
            capture.env_enumerated = True
            return base.__iter__(self)

        def __len__(self):
            capture.env_enumerated = True
            return base.__len__(self)

        def __repr__(self):
            capture.env_enumerated = True
            for key in list(base.__iter__(self)):
                self[key]
            return base.__repr__(self)

    os.environ.__class__ = RecordingEnviron
    if hasattr(os, 'environb'):
        os.environb.__class__ = RecordingEnviron


def _env_name(key):
    return os.fsdecode(key) if isinstance(key, bytes) else key


def _install_stat(capture):
    def stat(path, *, dir_fd=None, follow_symlinks=True):
        try:
            result = _real_stat(path, dir_fd=dir_fd, follow_symlinks=follow_symlinks)
        except OSError:
            capture.note_stat(path, dir_fd, None)
            raise
        capture.note_stat(path, dir_fd, result)
        return result

    def lstat(path, *, dir_fd=None):
        try:
            result = _real_lstat(path, dir_fd=dir_fd)
        except OSError:
            capture.note_stat(path, dir_fd, None)
            raise
        capture.note_stat(path, dir_fd, result)
        return result

    stat.__doc__ = _real_stat.__doc__
    lstat.__doc__ = _real_lstat.__doc__
    os.stat = stat
    os.lstat = lstat


def _install_spawn(capture):
    """
    Traces Python child processes. A child started through subprocess that runs this same
    interpreter (named by path) gets capture too: its environment gains the variables that load it
    (python/child/sitecustomize.py), and it writes a payload of its own, which this process merges
    at the end. Other programs, and processes started without subprocess (multiprocessing's spawn
    and forkserver), stay untraced and are recorded as such.
    """
    import inspect
    import subprocess
    import uuid

    try:
        import _posixsubprocess
    except ImportError:
        _posixsubprocess = None

    if _posixsubprocess is not None:
        real_fork_exec = _posixsubprocess.fork_exec

        def fork_exec(*args, **kwargs):
            # subprocess keeps its own reference: calls here come from elsewhere.
            if capture.active:
                argv = args[0] if args else None
                program = argv[0] if isinstance(argv, (list, tuple)) and argv else 'fork_exec'
                capture.spawns.append(os.fsdecode(program) if isinstance(program, bytes) else str(program))
            return real_fork_exec(*args, **kwargs)

        _posixsubprocess.fork_exec = fork_exec

    real = subprocess.Popen._execute_child
    try:
        names = list(inspect.signature(real).parameters)[1:]
        positions = {n: names.index(n) for n in ('args', 'executable', 'env', 'shell')}
    except (TypeError, ValueError):
        return
    executable_dir = os.path.dirname(os.path.abspath(sys.executable))
    boot_dir = os.path.join(capture.config['pluginDir'], 'child')

    def same_python(program):
        if program is None:
            return False
        p = os.fsdecode(program) if isinstance(program, bytes) else str(program)
        if not os.path.dirname(p):
            return False
        p = os.path.abspath(p)
        try:
            return os.path.dirname(p) == executable_dir and os.path.samefile(p, sys.executable)
        except OSError:
            return False

    def execute_child(self, *args, **kwargs):
        values = list(args)

        def get(name):
            i = positions[name]
            return values[i] if i < len(values) else kwargs.get(name)

        argv = get('args')
        if isinstance(argv, (str, bytes, os.PathLike)):
            argv = [argv]
        program = get('executable')
        if program is None and argv:
            program = list(argv)[0]
        env = get('env')
        bytes_env = env is not None and any(isinstance(n, bytes) for n in env)
        if not capture.active or get('shell') or bytes_env:
            return real(self, *args, **kwargs)
        with _Paused():
            traced = same_python(program)
        if not traced:
            return real(self, *args, **kwargs)
        with _Paused():
            given = dict(os.environ) if env is None else dict(env)
            parent = dict(os.environ)
            overridden = sorted(
                os.fsdecode(n) if isinstance(n, bytes) else n
                for n in set(given) | set(parent)
                if given.get(n) != parent.get(n)
            )
            child_id = uuid.uuid4().hex
            config = dict(capture.config)
            config.update(
                mode='child',
                childId=child_id,
                payload=os.path.join(capture.children_dir, f'{child_id}.json'),
                pythonPath=given.get('PYTHONPATH'),
            )
            child_env = dict(given)
            child_env[CONFIG_ENV] = json.dumps(config)
            child_env['PYTHONPATH'] = os.pathsep.join(
                [boot_dir, *([given['PYTHONPATH']] if given.get('PYTHONPATH') else [])]
            )
        i = positions['env']
        if i < len(values):
            values[i] = child_env
        else:
            kwargs['env'] = child_env
        shown = os.fsdecode(program) if isinstance(program, bytes) else str(program)
        capture.injected[child_id] = {'program': shown, 'overridden': overridden}
        capture.local.traced = True
        try:
            return real(self, *values, **kwargs)
        finally:
            capture.local.traced = False

    subprocess.Popen._execute_child = execute_child


def _start(config):
    global _capture
    _capture = _Capture(config)
    os.makedirs(_capture.children_dir, exist_ok=True)
    _install_environ(_capture)
    _install_stat(_capture)
    _install_spawn(_capture)
    sys.addaudithook(_capture.audit)
    _start_monitoring(_capture)
    atexit.register(_capture.finish)


_mode = _config.get('mode') if _config is not None else None
if _mode == 'child' or (_mode == 'run' and _config.get('capture')):
    _start(_config)


class _Paused:
    """Veyrum's own file writes are not the test's."""

    def __enter__(self):
        self.was = _capture.active if _capture is not None else False
        if _capture is not None:
            _capture.active = False

    def __exit__(self, *exc):
        if _capture is not None:
            _capture.active = self.was


def _write_json(path, data):
    with _Paused():
        tmp = f'{path}.{os.getpid()}.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        os.replace(tmp, path)


# --- pytest hooks ---------------------------------------------------------------------------

_tests = {}
_collect_errors = []
_session_started = time.perf_counter()


def _file_of(config, nodeid):
    return os.path.normpath(os.path.join(str(config.rootpath), nodeid.split('::')[0]))


def pytest_collectreport(report):
    if _config is not None and report.failed:
        _collect_errors.append(report.nodeid)


def pytest_runtest_logreport(report):
    if _config is None or _config.get('mode') != 'run':
        return
    entry = _tests.get(report.nodeid)
    if entry is None:
        name = report.nodeid.split('::', 1)[1] if '::' in report.nodeid else report.nodeid
        entry = _tests[report.nodeid] = {'name': name, 'state': 'passed', 'durationMs': 0.0, 'retries': 0}
    entry['durationMs'] += report.duration * 1000
    if report.failed:
        entry['state'] = 'failed'
    elif report.skipped and entry['state'] != 'failed':
        entry['state'] = 'skipped'


def pytest_sessionfinish(session, exitstatus):
    if _config is None:
        return
    config = session.config
    if _config.get('mode') == 'collect':
        files = {str(item.path) for item in session.items}
        files.update(_file_of(config, nodeid) for nodeid in _collect_errors if nodeid)
        _write_json(
            _config['collectFile'],
            {
                'files': sorted(files),
                'rootpath': str(config.rootpath),
                'inipath': str(config.inipath) if config.inipath else None,
                'xdist': bool(config.pluginmanager.hasplugin('xdist')),
            },
        )
        return
    failed = bool(_collect_errors) or any(t['state'] == 'failed' for t in _tests.values())
    _write_json(
        _config['report'],
        {
            'verdict': 'fail' if failed else 'pass',
            'exitStatus': int(exitstatus),
            'durationMs': (time.perf_counter() - _session_started) * 1000,
            'tests': list(_tests.values()),
        },
    )
