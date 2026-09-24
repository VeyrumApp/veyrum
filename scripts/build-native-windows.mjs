// Builds the Windows child-process tracer: veyrum-trace.dll (packages/capture/native/trace-win.c),
// loaded into every process a test starts, and veyrum-exec.exe (exec-win.c), which starts a
// program with it. Both are compiled with Microsoft Detours (MIT), fetched at a pinned commit, and
// the Visual C++ compiler: from the environment (a Developer prompt), else the newest Visual
// Studio installation vswhere finds. Without one, nothing is built and tracing falls back as on
// platforms where it is not built.
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Microsoft Detours, fetched at this commit and verified. */
const DETOURS_REPOSITORY = 'https://github.com/microsoft/Detours.git'
const DETOURS_COMMIT = 'adb07604aa56508448b95bf037c2a6d0d3b6831a'
/** Detours' own library sources (src/Makefile); uimports.cpp is included by creatwth.cpp. */
const DETOURS_SOURCES = [
  'detours.cpp',
  'modules.cpp',
  'disasm.cpp',
  'image.cpp',
  'creatwth.cpp',
  'disolx86.cpp',
  'disolx64.cpp',
  'disolia64.cpp',
  'disolarm.cpp',
  'disolarm64.cpp',
]

/** An environment in which `cl` runs, or null when no Visual C++ compiler is installed. */
function compilerEnvironment() {
  if (spawnSync('where', ['cl'], { stdio: 'ignore' }).status === 0) return process.env
  const programFiles = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const vswhere = path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (!fs.existsSync(vswhere)) return null
  const installation = execFileSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { encoding: 'utf8' },
  ).trim()
  const vcvars = installation && path.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
  if (!vcvars || !fs.existsSync(vcvars)) return null
  // The variables vcvars64.bat sets, as `set` prints them afterwards (execSync runs cmd.exe).
  const output = execSync(`"${vcvars}" >nul && set`, { encoding: 'utf8' })
  const env = {}
  for (const line of output.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return env
}

/** Detours' sources at the pinned commit, fetched once into node_modules/.cache. */
function detoursSources(root) {
  const dir = path.join(root, 'node_modules', '.cache', 'veyrum-detours', DETOURS_COMMIT)
  const git = (cwd, args) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  if (fs.existsSync(path.join(dir, 'src', 'detours.h')) && git(dir, ['rev-parse', 'HEAD']) === DETOURS_COMMIT)
    return path.join(dir, 'src')
  fs.rmSync(dir, { recursive: true, force: true })
  const temporary = `${dir}.${process.pid}`
  fs.rmSync(temporary, { recursive: true, force: true })
  fs.mkdirSync(temporary, { recursive: true })
  git(temporary, ['init', '--quiet'])
  git(temporary, ['fetch', '--quiet', '--depth', '1', DETOURS_REPOSITORY, DETOURS_COMMIT])
  git(temporary, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', 'FETCH_HEAD'])
  const head = git(temporary, ['rev-parse', 'HEAD'])
  if (head !== DETOURS_COMMIT)
    throw new Error(`build-native: Detours fetched at ${head}, expected ${DETOURS_COMMIT}`)
  fs.renameSync(temporary, dir)
  return path.join(dir, 'src')
}

/** Copies a built file into place under a temporary name first (the build directory may be on another drive). */
function place(from, to) {
  const temporary = `${to}.${process.pid}`
  fs.copyFileSync(from, temporary)
  fs.renameSync(temporary, to)
}

export function buildWindows(root, nativeDir) {
  if (process.arch !== 'x64') {
    console.log(`build-native: child-process tracing is not built on win32-${process.arch}`)
    return
  }
  const env = compilerEnvironment()
  if (!env) {
    console.log('build-native: no Visual C++ compiler; child-process tracing is not built')
    return
  }
  let detours
  try {
    detours = detoursSources(root)
  } catch (error) {
    console.log(
      `build-native: Microsoft Detours could not be fetched; child-process tracing is not built\n${error.message}`,
    )
    return
  }
  const native = path.join(root, 'packages', 'capture', 'native')
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'veyrum-native-'))
  try {
    const cl = (args) => execFileSync('cl', ['/nologo', ...args], { cwd: build, env, stdio: 'inherit' })
    // The static C runtime (/MT): the DLL runs inside arbitrary programs, which need not have the
    // Visual C++ runtime installed.
    const common = ['/O2', '/MT', '/DWIN32_LEAN_AND_MEAN', '/D_WIN32_WINNT=0x0A00', `/I${detours}`]
    cl(['/c', '/W3', ...common, ...DETOURS_SOURCES.map((file) => path.join(detours, file))])
    const objects = DETOURS_SOURCES.map((file) => path.join(build, file.replace(/\.cpp$/, '.obj')))
    const strict = ['/W4']
    cl([
      ...strict,
      ...common,
      '/LD',
      path.join(native, 'trace-win.c'),
      ...objects,
      `/Fe${path.join(build, 'veyrum-trace.dll')}`,
      '/link',
      // Detours loads a DLL through an import table only when it exports ordinal 1.
      '/EXPORT:DetourFinishHelperProcess,@1,NONAME',
    ])
    cl([
      ...strict,
      ...common,
      path.join(native, 'exec-win.c'),
      ...objects,
      `/Fe${path.join(build, 'veyrum-exec.exe')}`,
    ])
    fs.mkdirSync(nativeDir, { recursive: true })
    place(path.join(build, 'veyrum-trace.dll'), path.join(nativeDir, 'veyrum-trace.dll'))
    place(path.join(build, 'veyrum-exec.exe'), path.join(nativeDir, 'veyrum-exec.exe'))
  } finally {
    fs.rmSync(build, { recursive: true, force: true })
  }
}
