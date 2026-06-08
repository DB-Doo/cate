// =============================================================================
// CompanionTransport — how a daemon is launched and reached. All transports
// resolve to a duplex line pipe (CompanionChannel) that the CompanionRpcClient
// sits on; only bootstrap/launch differ between local subprocess, SSH, and WSL.
// =============================================================================

export interface CompanionChannel {
  /** Write one already-serialized frame line to the daemon's stdin. */
  write(line: string): void
  /** Register the stdout data handler. Called once, synchronously after launch. */
  onData(cb: (chunk: string | Buffer) => void): void
  /** Register a stderr handler — surfaced in connect errors so a daemon that
   *  fails to start (node missing, node-pty missing, …) gives a real reason. */
  onStderr?(cb: (chunk: string | Buffer) => void): void
  /** Register the close handler (process exit / connection drop). */
  onClose(cb: (info: { code: number | null }) => void): void
  /** Forcibly terminate the daemon / close the connection. */
  kill(): void
}

// -----------------------------------------------------------------------------
// Shared remote-install helpers — SSH and WSL provision the SAME self-contained
// tarball into the SAME `~/.cate/companion/<ver>/<target>` layout with identical
// markers, pull commands, and dev hot-swap flow; only the push mechanism (SFTP
// vs /mnt copy) and the exec primitive differ. These keep that logic in one
// place. localTransport keeps its own fs-based marker()/install (it never shells).
// -----------------------------------------------------------------------------

import log from '../../logger'
import { ensureLocalTarball, localCompanionBundlePath, tarballHash, type CompanionTarget } from '../companionArtifacts'

/** Minimal POSIX shell-quote for argv interpolated into a remote command string. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Result of running a shell command on a remote host (never throws form). */
export interface RemoteExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Compute the `.ok` freshness marker. When a local tarball is present (dev build
 *  / cache) it embeds the tarball's content hash so a changed daemon at the same
 *  version re-installs automatically; otherwise (production pull) it is just the
 *  version. */
export async function computeMarker(version: string, localTar: string | null): Promise<string> {
  return localTar ? `${version}:${await tarballHash(localTar)}` : version
}

/** Whether a host's stored `.ok` marker means the correct bundle is installed.
 *  Exact match on the hash-aware marker, or (no local tarball) a version prefix
 *  match so a production pull whose marker is just the version still counts. */
export function markersMatch(ok: string, marker: string, localTar: string | null, version: string): boolean {
  return ok === marker || (!localTar && ok.startsWith(version))
}

/** sh test that the current-version bundle is installed: node runtime + cjs
 *  present and the `.ok` marker readable (its bytes are matched by markersMatch).
 *  `quotedInstallDir` must be shell-quoted (as provisionedProbe expects). */
export function buildInstallCheckCommand(quotedInstallDir: string): string {
  return `test -x ${quotedInstallDir}/runtime/bin/node && test -f ${quotedInstallDir}/companion.cjs && cat ${quotedInstallDir}/.ok 2>/dev/null`
}

/** sh tail run from inside the install dir after the tarball is in place as
 *  `pkg.tgz`: extract -> verify runtime + cjs -> write the `.ok` marker -> echo
 *  the success token. `quotedMarker` must already be shell-quoted; `okToken` is
 *  the sentinel the caller greps for (CATE_EXTRACT_OK / CATE_PULL_OK). */
export function buildExtractCommand(quotedMarker: string, okToken: string): string {
  return (
    `tar -xzf pkg.tgz && rm -f pkg.tgz && ` +
    `test -x runtime/bin/node && test -f companion.cjs && ` +
    `printf %s ${quotedMarker} > .ok && echo ${okToken}`
  )
}

/** Compound sh command: download (curl|wget) -> extract -> verify -> mark `.ok`.
 *  Echoes CATE_PULL_OK on success; CATE_NO_FETCHER + exit 3 when neither tool. */
export function buildRemotePullCommand(installDir: string, url: string, version: string): string {
  const D = shellQuote(installDir)
  const U = shellQuote(url)
  const V = shellQuote(version)
  return (
    `mkdir -p ${D} && cd ${D} && rm -f pkg.tgz && ` +
    `if command -v curl >/dev/null 2>&1; then curl -fSL ${U} -o pkg.tgz; ` +
    `elif command -v wget >/dev/null 2>&1; then wget -qO pkg.tgz ${U}; ` +
    `else echo CATE_NO_FETCHER >&2; exit 3; fi && ` +
    buildExtractCommand(V, 'CATE_PULL_OK')
  )
}

/** sh test that the heavy parts are provisioned (runtime + rg + pi + cjs +
 *  node_modules). Echoes CATE_PROVISIONED when all present. `D` must be shell-quoted. */
export function provisionedProbe(quotedInstallDir: string): string {
  return `test -x ${quotedInstallDir}/runtime/bin/node && test -x ${quotedInstallDir}/runtime/bin/rg && test -f ${quotedInstallDir}/pi/dist/cli.js && test -f ${quotedInstallDir}/companion.cjs && test -d ${quotedInstallDir}/node_modules && echo CATE_PROVISIONED`
}

/** Transport-specific bits the shared dev provisioner needs. */
export interface BootstrapDevDeps {
  /** Log tag, e.g. 'ssh' / 'wsl'. */
  tag: 'ssh' | 'wsl'
  /** Run a shell command on the host (must not throw; returns code+output). */
  exec(cmd: string): Promise<RemoteExecResult>
  /** Full-tarball provision into the install dir, writing the given `.ok` marker. */
  pushTarball(version: string, marker: string): Promise<void>
  /** Overlay just the freshest local companion.cjs onto an already-provisioned
   *  host and write `.cjs.ok = hash` (SFTP put / wslpath cp). `D` is shell-quoted. */
  pushBundle(bundle: string, hash: string, quotedInstallDir: string): Promise<void>
}

/**
 * Dev provisioning shared by SSH and WSL. Installs the heavy parts (runtime +
 * node_modules + node-pty) from the local tarball once, then overlays the
 * freshest local companion.cjs keyed by its content hash in `.cjs.ok`. Subsequent
 * connects with an unchanged bundle are a single hash check; a changed bundle is a
 * ~262KB push. Never remote-pulls — the host runs whatever `build:companion` last
 * produced. `D` is the shell-quoted install dir.
 */
export async function bootstrapDevShared(version: string, D: string, deps: BootstrapDevDeps): Promise<void> {
  const provisioned = (await deps.exec(provisionedProbe(D))).stdout.includes('CATE_PROVISIONED')

  // First connect on this host/version: lay down runtime + node_modules from the
  // local tarball (marker is just the version; the cjs overlay below is the real
  // freshness key in dev). No remote-pull.
  if (!provisioned) await deps.pushTarball(version, version)

  const bundle = localCompanionBundlePath()
  if (!bundle) {
    if (!provisioned) return // just installed from the tarball; nothing newer to push
    log.warn('[companion:%s] dev mode but dist-companion/companion.cjs missing; run `npm run build:companion`', deps.tag)
    return
  }

  const h = await tarballHash(bundle)
  const ok = (await deps.exec(`cat ${D}/.cjs.ok 2>/dev/null`)).stdout.trim()
  if (provisioned && ok === h) return // host already runs this exact bundle

  await deps.pushBundle(bundle, h, D)
  log.info('[companion:%s] dev fast-push companion.cjs (%s)', deps.tag, h)
}

export interface CompanionTransport {
  readonly kind: 'local' | 'server' | 'wsl'
  /**
   * Probe whether the correct-version daemon bundle is already installed on the
   * host, WITHOUT installing anything. Connecting the transport happens here, so
   * a failure to reach the host surfaces (the manager maps it to `unreachable`);
   * resolving `false` means the host is reachable but the daemon needs to be
   * installed (the manager maps that to `missing`). Optional — a transport that
   * omits it is treated as always-installed (local subprocess / in-proc fakes).
   */
  isInstalled?(expectedVersion: string): Promise<boolean>
  /** Ensure the correct-version companion bundle is present on the host. When
   *  `force` is set, wipe any existing install first so a corrupt or partial
   *  bundle is replaced by a clean download/push+extract (the reinstall path). */
  bootstrap(expectedVersion: string, force?: boolean): Promise<void>
  /** Remove the companion install from the host (rm -rf ~/.cate/companion).
   *  Backs the explicit "Delete companion" action. Optional — omitted by
   *  transports with nothing host-side to remove. */
  uninstall?(): Promise<void>
  /** Launch the daemon and return its stdio channel. */
  launch(): Promise<CompanionChannel>
  /** Release transport-level resources (SSH connection, etc.). */
  dispose(): Promise<void>
}
