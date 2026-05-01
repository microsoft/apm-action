import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as tc from '@actions/tool-cache';
import * as path from 'path';

const REPO = 'microsoft/apm';
const GITHUB_API = 'https://api.github.com';

/**
 * Map Node.js platform/arch to the APM asset naming convention.
 */
export function getAssetSuffix(): string {
  const platform = process.platform;
  const arch = process.arch;

  let os: string;
  if (platform === 'darwin') os = 'darwin';
  else if (platform === 'linux') os = 'linux';
  else throw new Error(`Unsupported platform: ${platform}`);

  let cpu: string;
  if (arch === 'x64') cpu = 'x86_64';
  else if (arch === 'arm64') cpu = 'arm64';
  else throw new Error(`Unsupported architecture: ${arch}`);

  return `${os}-${cpu}`;
}

/**
 * Resolve the download URL for a specific APM version.
 * For 'latest', queries the GitHub Releases API (no auth needed for public repos).
 * For a pinned version, constructs the URL directly.
 */
export async function resolveDownloadUrl(version: string): Promise<{ url: string; resolvedVersion: string }> {
  const suffix = getAssetSuffix();
  const assetName = `apm-${suffix}.tar.gz`;

  if (version === 'latest') {
    const token = core.getInput('github-token');
    const headers: Record<string, string> = { 'Accept': 'application/vnd.github+json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const resp = await fetch(`${GITHUB_API}/repos/${REPO}/releases/latest`, { headers });
    if (!resp.ok) throw new Error(`Failed to fetch latest release: ${resp.status} ${resp.statusText}`);
    const data = await resp.json() as { tag_name: string };
    const tag = data.tag_name;
    if (!tag) throw new Error('Failed to resolve latest APM release tag');
    const resolvedVersion = tag.replace(/^v/, '');
    return {
      url: `https://github.com/${REPO}/releases/download/${tag}/${assetName}`,
      resolvedVersion
    };
  }

  // Pinned version — normalize to a v-prefixed tag
  const tag = version.startsWith('v') ? version : `v${version}`;
  return {
    url: `https://github.com/${REPO}/releases/download/${tag}/${assetName}`,
    resolvedVersion: version.replace(/^v/, '')
  };
}

export interface InstallResult {
  /**
   * The resolved version that ended up on PATH. For an explicit `apm-version`
   * input this matches the request; for `latest` it is the version the GitHub
   * Releases API returned (or the version reported by an already-on-PATH apm).
   */
  resolvedVersion: string;
  /**
   * Directory containing the apm binary as added to PATH. Empty string if the
   * action reused an apm binary that was already on PATH (we cannot know its
   * tool-cache directory in that case).
   */
  toolDir: string;
  /**
   * Full path to the apm executable. Useful for `apm-path` action output and
   * for diagnostics. Empty string if reusing a pre-existing PATH apm.
   */
  binaryPath: string;
}

/**
 * Resolve the version reported by an apm binary that is already on PATH.
 * Returns the cleaned version string (no leading 'v'), or null if apm is not
 * available or the probe failed.
 */
async function probePathVersion(): Promise<string | null> {
  try {
    const result = await exec.getExecOutput('apm', ['--version'], {
      ignoreReturnCode: true,
      silent: true,
    });
    if (result.exitCode !== 0) return null;
    // `apm --version` prints e.g. "apm 0.11.0" or "0.11.0" depending on build.
    const match = /(\d+\.\d+\.\d+\S*)/.exec(result.stdout);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Ensure APM CLI is installed and available on the runner.
 * Uses @actions/tool-cache for downloading, extracting, and caching.
 *
 * Version semantics:
 *   - `apm-version: latest` -- resolves the latest GitHub release tag, then
 *     reuses an apm already on PATH ONLY if its version equals the latest
 *     release. Otherwise installs the latest release via tool-cache. If the
 *     GitHub Releases API is unreachable, falls back to the PATH apm with a
 *     warning so the action still works in degraded environments.
 *   - `apm-version: <pinned>` -- always installs the requested version into
 *     the tool-cache (or reuses a tool-cache hit). Never short-circuits to a
 *     random apm that happens to be on PATH; the caller asked for a specific
 *     version and gets that version.
 */
export async function ensureApmInstalled(): Promise<InstallResult> {
  const apmVersionInput = (core.getInput('apm-version') || 'latest').trim();
  const wantLatest = apmVersionInput === 'latest' || apmVersionInput === '';

  if (wantLatest) {
    // Resolve the actual latest tag from GitHub FIRST, then decide whether a
    // pre-existing PATH apm is acceptable. This closes the silent-downgrade
    // foot-gun where `apm-version: latest` would happily reuse a months-old
    // apm just because it's already on PATH.
    let upstreamLatest: string | null = null;
    try {
      const resolved = await resolveDownloadUrl('latest');
      upstreamLatest = resolved.resolvedVersion;
    } catch (err) {
      // GitHub API unreachable (rate limit, network issue, etc.). Fall back to
      // probing PATH so the action still succeeds in degraded environments,
      // but warn loudly so operators know they may be running stale.
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(
        `Failed to resolve latest APM release from GitHub (${msg}). ` +
        `Falling back to any apm already on PATH; pin apm-version to a specific ` +
        `tag (e.g. apm-version: 0.11.0) for reproducibility.`
      );
    }

    const pathVersion = await probePathVersion();
    if (pathVersion && (upstreamLatest === null || pathVersion === upstreamLatest)) {
      core.info(`APM ${pathVersion} already available on PATH (apm-version: latest)`);
      let binaryPath = '';
      try {
        const which = await exec.getExecOutput('which', ['apm'], { silent: true });
        if (which.exitCode === 0) binaryPath = which.stdout.trim();
      } catch {
        // ignore
      }
      return { resolvedVersion: pathVersion, toolDir: '', binaryPath };
    }
    if (pathVersion && upstreamLatest !== null && pathVersion !== upstreamLatest) {
      core.info(
        `Found apm ${pathVersion} on PATH but latest release is ${upstreamLatest}; ` +
        `installing fresh to honour apm-version: latest.`
      );
    }
  }

  core.info(`Installing APM (version: ${apmVersionInput})...`);

  const { url, resolvedVersion } = await resolveDownloadUrl(apmVersionInput);
  const suffix = getAssetSuffix();

  // Check tool-cache first
  let toolDir = tc.find('apm', resolvedVersion);

  if (!toolDir) {
    core.info(`Downloading APM ${resolvedVersion} from ${url}`);
    const downloadPath = await tc.downloadTool(url);
    const extractedDir = await tc.extractTar(downloadPath);

    // The tarball extracts to apm-{os}-{arch}/ containing the apm binary
    const innerDir = path.join(extractedDir, `apm-${suffix}`);
    toolDir = await tc.cacheDir(innerDir, 'apm', resolvedVersion);
  } else {
    core.info(`APM ${resolvedVersion} found in tool cache`);
  }

  // Add to PATH
  core.addPath(toolDir);

  // Verify
  const verify = await exec.exec('apm', ['--version'], { ignoreReturnCode: true });
  if (verify !== 0) {
    throw new Error('APM installation verification failed');
  }

  core.info(`APM ${resolvedVersion} installed successfully`);

  const binaryPath = path.join(toolDir, 'apm');
  return { resolvedVersion, toolDir, binaryPath };
}
