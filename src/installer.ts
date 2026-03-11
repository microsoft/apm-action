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

/**
 * Ensure APM CLI is installed and available on the runner.
 * Uses @actions/tool-cache for downloading, extracting, and caching.
 */
export async function ensureApmInstalled(): Promise<void> {
  const apmVersion = core.getInput('apm-version') || 'latest';

  // Check if already available
  const rc = await exec.exec('apm', ['--version'], { ignoreReturnCode: true, silent: true }).catch(() => 1);
  if (rc === 0) {
    core.info('APM already installed');
    return;
  }

  core.info(`Installing APM (version: ${apmVersion})...`);

  const { url, resolvedVersion } = await resolveDownloadUrl(apmVersion);
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
}
