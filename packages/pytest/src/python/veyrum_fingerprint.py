"""Unit paths and fingerprints of Python modules, the counterpart of packages/core/src/fingerprint.ts.

A module is split into units: the module top level plus every function, method, lambda, generator
expression and class body, each of which CPython runs as its own code object. A unit's fingerprint
is a digest of its AST without positions, where every nested unit is replaced by its signature: what
the enclosing scope evaluates when it creates it (name, parameters with their defaults and
annotations, decorators, return annotation; bases and keywords of a class; the first iterable of a
generator expression). So:

- editing the body of a function changes only that function's unit;
- changing a function's parameters, name, decorators or defaults changes the enclosing unit;
- comments, formatting and quote style never change a fingerprint; docstrings do (``__doc__`` is
  observable).

Comprehensions are inlined into their scope since Python 3.12 (PEP 709) and belong to it.

Run as a program, it fingerprints the files named in a JSON array on stdin and writes
``{path: {unit: fingerprint} | null}`` to stdout (plan time, for files whose source changed).
"""

import ast
import base64
import hashlib
import json
import sys

# Bump when unit naming or canonicalization changes: fingerprints of different versions never match.
FINGERPRINT_VERSION = 'py1'
TOP_UNIT = '@top'
OPAQUE_UNIT = '@opaque'

_FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)
_UNITS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda, ast.GeneratorExp)
# Fields that never change behavior: `kind` is the `u` prefix of a string literal.
_SKIPPED_FIELDS = frozenset({'kind', 'type_comment'})


def digest_bytes(data):
    """The digest core's `digest` computes: sha256, base64url, 22 characters."""
    return base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode('ascii')[:22]


def digest(text):
    return digest_bytes(text.encode('utf-8', 'surrogatepass'))


class ModuleUnits:
    """Units of one module and the code objects each one runs as."""

    __slots__ = ('units', 'code_keys', 'opaque')

    def __init__(self, units, code_keys, opaque):
        # Unit path to fingerprint; always holds TOP_UNIT or OPAQUE_UNIT.
        self.units = units
        # (co_qualname, co_firstlineno) to the unit paths that code object can be.
        self.code_keys = code_keys
        self.opaque = opaque

    def locate(self, qualname, firstlineno):
        """Unit paths of a code object, or None when it matches no unit of this source."""
        if self.opaque:
            return [OPAQUE_UNIT]
        if qualname == '<module>':
            return [TOP_UNIT]
        return self.code_keys.get((qualname, firstlineno))


def _join(qual, name):
    return name if not qual else f'{qual}.{name}'


def analyze(source, root=None):
    """Units of a module's source (bytes or str)."""
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        raw = source if isinstance(source, bytes) else source.encode('utf-8', 'surrogatepass')
        return ModuleUnits({OPAQUE_UNIT: digest_bytes(b'opaque\n' + raw)}, {}, True)

    counters = {}
    found = []  # (node, unit path)
    code_keys = {}

    def add(node, parent_path, name, qualname, firstlineno):
        key = (parent_path, name)
        ordinal = counters.get(key, 0)
        counters[key] = ordinal + 1
        here = f'{parent_path}/{name}#{ordinal}'
        found.append((node, here))
        code_keys.setdefault((qualname, firstlineno), []).append(here)
        return here

    def visit_all(nodes, unit, qual, scope):
        for node in nodes:
            visit(node, None, unit, qual, scope)

    def visit_children(node, unit, qual, scope):
        for child in ast.iter_child_nodes(node):
            visit(child, node, unit, qual, scope)

    def generic_params(node, unit, qual):
        # PEP 695 type parameters run in an annotation scope of their own, which evaluates what the
        # signature holds: it belongs to the enclosing unit.
        if getattr(node, 'type_params', None):
            key = (_join(qual, f'<generic parameters of {node.name}>'), _first_line(node))
            code_keys.setdefault(key, []).append(unit)

    def visit_arguments(args, unit, qual, scope):
        visit_all(args.defaults, unit, qual, scope)
        visit_all([d for d in args.kw_defaults if d is not None], unit, qual, scope)
        for a in [*args.posonlyargs, *args.args, *args.kwonlyargs, args.vararg, args.kwarg]:
            if a is not None and a.annotation is not None:
                visit(a.annotation, None, unit, qual, scope)

    def visit(node, parent, unit, qual, scope):
        if isinstance(node, _FUNCTIONS):
            name = ('m:' if scope == 'class' else 'fn:') + node.name
            q = _join(qual, node.name)
            here = add(node, unit, name, q, _first_line(node))
            # Decorators, defaults and annotations are evaluated where the function is defined.
            visit_all(node.decorator_list, unit, qual, scope)
            visit_arguments(node.args, unit, qual, scope)
            if node.returns is not None:
                visit(node.returns, None, unit, qual, scope)
            generic_params(node, unit, qual)
            visit_all(node.body, here, f'{q}.<locals>', 'function')
        elif isinstance(node, ast.ClassDef):
            q = _join(qual, node.name)
            here = add(node, unit, f'class:{node.name}', q, _first_line(node))
            visit_all(node.decorator_list, unit, qual, scope)
            visit_all(node.bases, unit, qual, scope)
            visit_all(node.keywords, unit, qual, scope)
            generic_params(node, unit, qual)
            visit_all(node.body, here, q, 'class')
        elif isinstance(node, ast.Lambda):
            target = None
            if isinstance(parent, ast.Assign) and len(parent.targets) == 1 and parent.value is node:
                t = parent.targets[0]
                if isinstance(t, ast.Name):
                    target = t.id
            q = _join(qual, '<lambda>')
            here = add(node, unit, f'v:{target}' if target else 'lambda', q, node.lineno)
            visit_arguments(node.args, unit, qual, scope)
            visit(node.body, node, here, f'{q}.<locals>', 'function')
        elif isinstance(node, ast.GeneratorExp):
            q = _join(qual, '<genexpr>')
            here = add(node, unit, 'genexpr', q, node.lineno)
            first, *rest = node.generators
            # The first iterable is evaluated in the enclosing scope, the rest in the generator.
            visit(first.iter, None, unit, qual, scope)
            inner = f'{q}.<locals>'
            visit(node.elt, node, here, inner, 'function')
            visit(first.target, first, here, inner, 'function')
            visit_all(first.ifs, here, inner, 'function')
            visit_all(rest, here, inner, 'function')
        else:
            visit_children(node, unit, qual, scope)

    visit_all(tree.body, TOP_UNIT, '', 'module')

    norm = _string_normalizer(root)
    units = {TOP_UNIT: _fingerprint(tree, None, norm)}
    for node, path in found:
        units[path] = _fingerprint(node, node, norm)
    return ModuleUnits(units, code_keys, False)


def _first_line(node):
    # A decorated definition's code object starts at its first decorator.
    return min([node.lineno, *(d.lineno for d in node.decorator_list)])


def _string_normalizer(root):
    if not root:
        return lambda s: s
    return lambda s: s.replace(root, '<root>') if root in s else s


def _fingerprint(node, self_node, norm):
    out = []
    _write(node, self_node, norm, out)
    return digest(f'{FINGERPRINT_VERSION}\n' + ''.join(out))


def _write(value, self_node, norm, out):
    if isinstance(value, ast.AST):
        if value is not self_node and isinstance(value, _UNITS):
            _signature(value, self_node, norm, out)
            return
        out.append('{')
        out.append(type(value).__name__)
        for field in value._fields:
            if field in _SKIPPED_FIELDS:
                continue
            out.append(f' {field}:')
            _write(getattr(value, field, None), self_node, norm, out)
        out.append('}')
    elif isinstance(value, list):
        out.append('[')
        for item in value:
            _write(item, self_node, norm, out)
            out.append(',')
        out.append(']')
    elif value is None:
        out.append('_')
    elif isinstance(value, str):
        out.append(json.dumps(norm(value)))
    else:
        out.append(f'{type(value).__name__}({value!r})')


def _signature(node, self_node, norm, out):
    """What the enclosing scope evaluates when it creates a nested unit."""
    out.append(f'S({type(node).__name__}')
    if isinstance(node, _FUNCTIONS):
        parts = [node.name, node.args, node.decorator_list, node.returns, node.type_params]
    elif isinstance(node, ast.ClassDef):
        parts = [node.name, node.bases, node.keywords, node.decorator_list, node.type_params]
    elif isinstance(node, ast.Lambda):
        parts = [node.args]
    else:
        parts = [node.generators[0].iter]
    for part in parts:
        out.append(',')
        _write(part, self_node, norm, out)
    out.append(')')


def _main():
    root = sys.argv[1] if len(sys.argv) > 1 else None
    result = {}
    for path in json.load(sys.stdin):
        try:
            with open(path, 'rb') as f:
                source = f.read()
        except OSError:
            result[path] = None
            continue
        result[path] = analyze(source, root).units
    json.dump(result, sys.stdout)


if __name__ == '__main__':
    _main()
