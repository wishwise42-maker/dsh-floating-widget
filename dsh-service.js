import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const READY_PATTERN = /^dsh web: (http:\/\/127\.0\.0\.1:\d+)\b/m

/**
 * Derive the DSH workspace directory from the app installation location:
 * the portable layout puts the app folder inside the workspace, and the
 * workspace is recognizable by its `.dsh` home directory. Launching the
 * app from Explorer or a shortcut must not change where the service
 * resolves its home — previously it inherited the caller's cwd, so boots
 * from a different directory resolved a fresh, profile-less home and the
 * service failed to start (and with it, the floating panel).
 */
export function resolveWorkspaceDir(appExecutable) {
  const appDir = dirname(appExecutable)
  for (const candidate of [appDir, dirname(appDir)]) {
    if (existsSync(join(candidate, '.dsh'))) return candidate
  }
  return undefined
}

export function resolveDshEntry() {
  return unpackedPath(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/lib/bin.js')))
}

export function unpackedPath(path) {
  return path.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2')
}

export function extractReadyUrl(output) {
  return READY_PATTERN.exec(output)?.[1]
}

export function resolveWindowsPickerPatch() {
  return fileURLToPath(new URL('../config/windows-directory-picker.patch.yml', import.meta.url))
}

export function buildDshArgs(entry, {
  platform = process.platform,
  windowsPickerPatch = resolveWindowsPickerPatch(),
} = {}) {
  return [
    '--expose-internals',
    entry,
    '--profile',
    'web',
    ...(platform === 'win32' ? ['--patch', windowsPickerPatch] : []),
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ]
}

export function buildDshCommand({
  electronExecutable,
  entry = resolveDshEntry(),
  platform = process.platform,
} = {}) {
  if (!electronExecutable) {
    throw new Error('electronExecutable is required')
  }

  // Spawn the Electron executable directly with windowsHide: the .NET
  // hidden-console launcher proved fragile (CreateProcess failures), and a
  // direct spawn is strictly simpler and equally console-free.
  const args = buildDshArgs(entry, { platform })
  return { command: electronExecutable, args }
}

export function startDshService({
  electronExecutable,
  entry = resolveDshEntry(),
  environment = process.env,
  platform = process.platform,
  // Cold boots measured ~50 s on this deployment (supply-chain verification
  // included); keep the patience budget comfortably above that.
  timeoutMs = 120_000,
} = {}) {
  const { command, args } = buildDshCommand({
    electronExecutable,
    entry,
    platform,
  })

  // Deterministic cwd + home: anchor the service to the workspace that owns
  // this app installation, regardless of how the app was launched.
  const workspace = resolveWorkspaceDir(electronExecutable)

  const child = spawn(command, args, {
    env: {
      ...environment,
      ELECTRON_RUN_AS_NODE: '1',
      ...(workspace !== undefined && environment.DSH_HOME === undefined
        ? { DSH_HOME: join(workspace, '.dsh') }
        : {}),
    },
    cwd: workspace,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  let settled = false

  /* Persist the boot transcript so startup failures are diagnosable. */
  const bootLog = join(
    process.env.TEMP || join(workspace ?? '.', '..'),
    'dsh-desktop-service.log',
  )
  let bootLogWritten = false
  const writeBootLog = () => {
    if (bootLogWritten) return
    bootLogWritten = true
    try {
      writeFileSync(bootLog, `--- ${new Date().toISOString()} ---\ncwd: ${String(workspace)}\nDSH_HOME: ${String(environment.DSH_HOME ?? join(workspace ?? '', '.dsh'))}\ncommand: ${command} ${args.join(' ')}\n\n${output}\n`, { encoding: 'utf8' })
    } catch {
      /* diagnostics must never mask the real failure */
    }
  }

  const ready = new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      writeBootLog()
      callback(value)
    }

    const inspect = (chunk) => {
      output += chunk.toString()
      const url = extractReadyUrl(output)
      if (url) finish(resolve, url)
    }

    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.once('error', (error) => finish(reject, error))
    child.once('exit', (code, signal) => {
      finish(
        reject,
        new Error(`DeepSeek Harness stopped before it was ready (code ${String(code)}, signal ${String(signal)}).\n${output}`),
      )
    })

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      finish(reject, new Error(`DeepSeek Harness did not become ready within ${timeoutMs}ms.\n${output}`))
    }, timeoutMs)
  })

  const stop = () => {
    if (!child.killed && child.exitCode === null) {
      child.kill('SIGTERM')
    }
  }

  return { child, ready, stop }
}

export function dshEntryUrl() {
  return pathToFileURL(resolveDshEntry()).href
}
