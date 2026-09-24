#!/usr/bin/env node
// Copies the pytest adapter's Python sources (packages/pytest/src/python) next to its compiled code,
// where the adapter runs them with the project's Python.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'packages/pytest/src/python')
const target = path.join(root, 'packages/pytest/dist/python')

fs.rmSync(target, { recursive: true, force: true })
fs.cpSync(source, target, {
  recursive: true,
  filter: (file) =>
    path.basename(file) !== '__pycache__' && (fs.statSync(file).isDirectory() || file.endsWith('.py')),
})
