// =============================================================================
// WslTransport — runs the self-contained companion daemon inside a WSL distro
// via `wsl.exe`. Installs the matching linux tarball (companion.cjs +
// node_modules incl. node-pty + a bundled Node runtime) into
// ~/.cate/companion/<ver>/<target>/ so the distro needs nothing preinstalled
// (server-side `git` still needed for VCS).
//
//   1. IN-DISTRO PULL — the distro fetches its own tarball from the GitHub
//      release (curl/wget); WSL shares the host network so this usually works.
//   2. /mnt FALLBACK — otherwise the client-side tarball
//      (companionArtifacts.ensureLocalTarball) is copied in through /mnt.
//
// STATUS: implemented but NOT runtime-verified here (needs a Windows host with
// WSL).
// =============================================================================

import { spawn, execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import log from '../../logger'
import { ensureLocalTarball, localTarballIfPresent, isCompanionDevMode, releaseUrl, isCompanionTarget, type CompanionTarget } from '../companionArtifacts'
import { shellQuote as shq, computeMarker, markersMatch, buildRemotePullCommand, bootstrapDevShared, provisionedProbe, buildInstallCheckCommand, buildExtractCommand, type CompanionChannel, type CompanionTransport } from './transport'

const execFileP = promisify(execFile)

export interface WslOptions {
  distro: string
  /** Companion-absolute workspace root inside the distro. */
  root: string
  id: string
  exclusions?: string[]
}

export class WslTransport implements CompanionTransport {
  readonly kind = 'wsl'
  private child: ChildProcess | null = null
  private installDir = ''
  private target: CompanionTarget | '' = ''

  constructor(private readonly opts: WslOptions) {}

  private async wsl(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileP('wsl.exe', ['-d', this.opts.distro, '-e', ...args])
    return { stdout, stderr }
  }

  /** Run a /bin/sh script inside the distro; never throws (returns code+output). */
  private async wslSh(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await this.wsl(['sh', '-c', script])
      return { code: 0, stdout, stderr }
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string }
      return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(err) }
    }
  }

  /** Probe arch + resolve the version-specific install dir, caching both.
   *  Shared by isInstalled / bootstrap / launch / uninstall. */
  private async resolveInstallDir(version: string): Promise<string> {
    if (!this.target) {
      const { stdout: machine } = await this.wsl(['uname', '-m'])
      const arch = /(aarch64|arm64)/i.test(machine) ? 'arm64' : /(x86_64|amd64)/i.test(machine) ? 'x64' : null
      if (!arch) throw new Error(`Unsupported WSL arch: "${machine.trim()}"`)
      const target = `linux-${arch}`
      if (!isCompanionTarget(target)) throw new Error(`No companion build for target "${target}"`)
      this.target = target
    }
    if (!this.installDir) {
      const { stdout: home } = await this.wsl(['sh', '-c', 'echo $HOME'])
      this.installDir = `${home.trim()}/.cate/companion/${version}/${this.target}`
    }
    return this.installDir
  }

  /** Reachable + correct-version bundle present? Does NOT install. */
  async isInstalled(version: string): Promise<boolean> {
    const installDir = await this.resolveInstallDir(version)
    const D = shq(installDir)
    if (isCompanionDevMode()) {
      return (await this.wslSh(provisionedProbe(D))).stdout.includes('CATE_PROVISIONED')
    }
    const localTar = localTarballIfPresent(version, this.target as CompanionTarget)
    const marker = await computeMarker(version, localTar)
    const ok = (await this.wslSh(buildInstallCheckCommand(D))).stdout.trim()
    return markersMatch(ok, marker, localTar, version)
  }

  /** Remove the whole companion install tree inside the distro (all versions). */
  async uninstall(): Promise<void> {
    const { stdout: home } = await this.wsl(['sh', '-c', 'echo $HOME'])
    await this.wslSh(`rm -rf ${shq(`${home.trim()}/.cate/companion`)}`)
    this.installDir = ''
  }

  async bootstrap(version: string, force?: boolean): Promise<void> {
    const D = shq(await this.resolveInstallDir(version))

    // Reinstall: wipe the install dir (binaries + .ok/.cjs.ok markers) so the
    // provisioned/marker probes below see a clean slate and re-copy.
    if (force) await this.wslSh(`rm -rf ${D}`)

    // DEV: provision the heavy parts once, then hot-swap only companion.cjs by
    // hash (mirrors sshTransport.bootstrapDev) — no version bump, no /mnt of the
    // full tarball on every iteration, no in-distro pull of a stale release.
    if (isCompanionDevMode()) {
      await this.bootstrapDev(version, D)
      return
    }

    // See sshTransport: hash-aware marker so a changed daemon re-installs in dev.
    const localTar = localTarballIfPresent(version, this.target as CompanionTarget)
    const marker = await computeMarker(version, localTar)

    // Already installed and current?
    const installed = await this.wslSh(buildInstallCheckCommand(D))
    const ok = installed.stdout.trim()
    if (markersMatch(ok, marker, localTar, version)) return

    // 1. In-distro pull.
    const url = releaseUrl(version, this.target as CompanionTarget)
    const pull = await this.wslSh(buildRemotePullCommand(this.installDir, url, version))
    if (pull.stdout.includes('CATE_PULL_OK')) {
      log.info('[companion:wsl] %s pulled tarball from release', this.target)
      return
    }
    log.info('[companion:wsl] in-distro pull unavailable (%s); copying via /mnt', pull.stderr.trim() || `code ${pull.code}`)

    // 2. /mnt fallback — copy the client-side tarball in and extract.
    await this.copyTarball(version, marker)
  }

  /** Dev provisioning (mirrors sshTransport.bootstrapDev): install runtime +
   *  node_modules from the local tarball once via /mnt, then overlay the freshest
   *  local companion.cjs keyed by its hash in `.cjs.ok`. Never in-distro pulls. */
  private bootstrapDev(version: string, D: string): Promise<void> {
    return bootstrapDevShared(version, D, {
      tag: 'wsl',
      exec: (cmd) => this.wslSh(cmd),
      pushTarball: (v, marker) => this.copyTarball(v, marker),
      pushBundle: async (bundle, hash, quotedDir) => {
        const { stdout: srcMnt } = await this.wsl(['wslpath', bundle])
        const res = await this.wslSh(
          `mkdir -p ${quotedDir} && cp ${shq(srcMnt.trim())} ${quotedDir}/companion.cjs && ` +
            `printf %s ${shq(hash)} > ${quotedDir}/.cjs.ok && echo CATE_CJS_OK`,
        )
        if (!res.stdout.includes('CATE_CJS_OK')) {
          throw new Error(`WSL dev companion.cjs push failed: ${res.stderr || res.stdout}`)
        }
      },
    })
  }

  private async copyTarball(version: string, marker: string): Promise<void> {
    if (!this.target) throw new Error('copyTarball called before arch probe')
    const localTar = await ensureLocalTarball(version, this.target)
    const { stdout: srcMnt } = await this.wsl(['wslpath', localTar])
    const D = shq(this.installDir)
    const extract = await this.wslSh(
      `mkdir -p ${D} && cd ${D} && cp ${shq(srcMnt.trim())} pkg.tgz && ` +
        buildExtractCommand(shq(marker), 'CATE_EXTRACT_OK'),
    )
    if (!extract.stdout.includes('CATE_EXTRACT_OK')) {
      throw new Error(`WSL extract failed: ${extract.stderr || extract.stdout}`)
    }
  }

  async launch(): Promise<CompanionChannel> {
    const nodeBin = `${this.installDir}/runtime/bin/node`
    const args = ['-d', this.opts.distro, '-e', nodeBin, `${this.installDir}/companion.cjs`, '--root', this.opts.root, '--id', this.opts.id]
    if (this.opts.exclusions?.length) args.push('--exclude', this.opts.exclusions.join(','))
    const child = spawn('wsl.exe', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    return {
      write: (line) => { child.stdin?.write(line) },
      onData: (cb) => { child.stdout?.on('data', cb) },
      onStderr: (cb) => { child.stderr?.on('data', cb) },
      onClose: (cb) => { child.on('close', (code) => cb({ code })) },
      kill: () => { child.kill() },
    }
  }

  async dispose(): Promise<void> {
    this.child?.kill()
    this.child = null
  }
}
