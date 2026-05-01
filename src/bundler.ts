import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as glob from '@actions/glob';
import * as fs from 'fs';
import * as path from 'path';

export type BundleFormat = 'apm' | 'plugin';

export interface ExtractResult {
  files: number;
  verified: boolean;
  format: BundleFormat;
}

/**
 * Resolve a local bundle path (may contain glob patterns) to a single file.
 * Errors if zero or multiple files match.
 */
export async function resolveLocalBundle(pattern: string, workspaceDir: string): Promise<string> {
  const resolvedWorkspace = path.resolve(workspaceDir);

  // If the pattern is an absolute path without globs, use it directly
  const resolvedPattern = path.isAbsolute(pattern) ? pattern : path.join(resolvedWorkspace, pattern);

  const globber = await glob.create(resolvedPattern, { followSymbolicLinks: false });
  const matches = await globber.glob();

  if (matches.length === 0) {
    throw new Error(`No bundle found matching: ${pattern}`);
  }

  if (matches.length > 1) {
    const list = matches.map(m => path.relative(resolvedWorkspace, m)).join(', ');
    throw new Error(`Multiple bundles match '${pattern}': ${list}. Use an exact path.`);
  }

  const resolvedBundle = path.resolve(matches[0]);

  // Path traversal protection for relative patterns: ensure resolved path stays
  // within the workspace. Absolute patterns are user-explicit and not checked —
  // the user intentionally specified a location (e.g. /tmp/gh-aw/apm-bundle/).
  if (!path.isAbsolute(pattern)) {
    const relative = path.relative(resolvedWorkspace, resolvedBundle);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Bundle path "${pattern}" resolves outside the workspace`);
    }
  }

  return resolvedBundle;
}

/**
 * Inspect a bundle archive to determine its format without extracting it.
 *
 * Reads the tar table-of-contents (`tar tzf`) and looks for the format
 * markers:
 *   - APM bundle: `apm.lock.yaml` (lockfile-driven, .github/.claude trees)
 *   - Plugin bundle: `plugin.json` at the bundle root (Claude Code marketplace
 *     layout, flat agents/skills/commands/instructions/ dirs, no lockfile)
 *
 * Returns the detected format. Throws if neither marker is present, or if
 * BOTH are present (ambiguous archive -- almost certainly a build error).
 *
 * Bundles always have a single top-level wrapper directory (the package
 * versioned dir, e.g. `pack-test-1.0.0/`). We accept the marker at any depth
 * inside the wrapper to stay tolerant of archive shape changes.
 */
export async function detectBundleFormat(bundlePath: string): Promise<BundleFormat> {
  const list = await exec.getExecOutput('tar', ['tzf', bundlePath], {
    ignoreReturnCode: true,
    silent: true,
  });
  if (list.exitCode !== 0) {
    throw new Error(
      `Failed to list bundle contents (tar tzf exit ${list.exitCode}): `
      + (list.stderr.trim() || 'unknown error'),
    );
  }

  const entries = list.stdout.split('\n').map(l => l.trim()).filter(Boolean);
  const hasLockfile = entries.some(e => /(^|\/)apm\.lock\.yaml$/.test(e));
  const hasPluginJson = entries.some(e => /(^|\/)plugin\.json$/.test(e));

  if (hasLockfile && hasPluginJson) {
    throw new Error(
      `Bundle ${path.basename(bundlePath)} contains both apm.lock.yaml and plugin.json -- `
      + `ambiguous format. Re-pack with a single --format value.`,
    );
  }
  if (hasLockfile) return 'apm';
  if (hasPluginJson) return 'plugin';

  throw new Error(
    `Bundle ${path.basename(bundlePath)} contains neither apm.lock.yaml nor plugin.json. `
    + `Cannot determine bundle format -- the archive may be corrupt or produced by an `
    + `unsupported tool.`,
  );
}
export async function extractBundle(bundlePath: string, outputDir: string): Promise<ExtractResult> {
  const resolvedBundle = path.resolve(bundlePath);
  const resolvedOutput = path.resolve(outputDir);

  if (!fs.existsSync(resolvedBundle)) {
    throw new Error(`Bundle not found: ${bundlePath}`);
  }

  // Detect the bundle format up-front. Plugin-format restore is rejected with
  // a clear message: deploying plugin bundles into a workspace is a different
  // contract (no lockfile to drive deployed_files, files land at workspace
  // root, plugin.json may collide with project files). That belongs in
  // `apm unpack` upstream, not here. See PR description for the deferred RFC.
  const format = await detectBundleFormat(resolvedBundle);
  if (format === 'plugin') {
    throw new Error(
      `Plugin-format bundle restore is not yet supported by this action. `
      + `The bundle at ${path.basename(bundlePath)} was packed with --format plugin `
      + `(no apm.lock.yaml, flat plugin layout). Either:\n`
      + `  - Re-pack the bundle with bundle-format: apm (or 'apm pack --format apm'), or\n`
      + `  - Restore the plugin bundle yourself using your plugin tooling.\n`
      + `Tracking: plugin-bundle restore is planned via 'apm unpack' upstream.`,
    );
  }

  // APM-format path: prefer `apm unpack` (provides verification),
  // fall back to `tar xzf` if APM is unavailable.
  const apmAvailable = await exec.exec('apm', ['--version'], {
    ignoreReturnCode: true,
    silent: true,
  }).catch(() => 1) === 0;

  if (apmAvailable) {
    core.info('Using apm unpack (with verification)...');
    const rc = await exec.exec('apm', ['unpack', resolvedBundle, '-o', resolvedOutput], {
      ignoreReturnCode: true,
    });
    if (rc !== 0) {
      throw new Error(`apm unpack failed with exit code ${rc}`);
    }
    const files = countDeployedFiles(resolvedOutput);
    return { files, verified: true, format };
  }

  // Fallback: tar extraction.
  //
  // Defense-in-depth: even if this path ever runs again (e.g. if a future
  // change reintroduces a "skip apm install" mode, or apm install transiently
  // fails), exclude the lockfile + manifest. They are bundle metadata, not
  // deployable output -- the same files that `apm unpack` (the primary path)
  // intentionally never copies. Leaking them into a git checkout dirties the
  // workspace and breaks downstream `git checkout` steps. See microsoft/apm-action#26.
  core.info('APM not available -- extracting with tar (no verification)...');
  const rc = await exec.exec('tar', [
    'xzf', resolvedBundle,
    '-C', resolvedOutput,
    '--strip-components=1',
    '--exclude=apm.lock.yaml',
    '--exclude=apm.lock',
    '--exclude=apm.yml',
  ], {
    ignoreReturnCode: true,
  });
  if (rc !== 0) {
    throw new Error(`tar extraction failed with exit code ${rc}`);
  }
  const files = countDeployedFiles(resolvedOutput);
  return { files, verified: false, format };
}

/**
 * Run `apm pack` after install and return the path to the produced bundle
 * along with the format that was used.
 */
export async function runPackStep(
  workingDir: string,
  opts: { target?: string; archive: boolean; format: BundleFormat },
): Promise<{ bundlePath: string; format: BundleFormat }> {
  const resolvedDir = path.resolve(workingDir);
  const buildDir = path.join(resolvedDir, 'build');

  // Always pass --format explicitly so this action's behavior is robust to
  // any future change in the apm CLI's default. The action's contract is
  // the action's, not the CLI's.
  const args = ['pack', '-o', buildDir, '--format', opts.format];
  if (opts.target) {
    args.push('--target', opts.target);
  }
  if (opts.archive) {
    args.push('--archive');
  }

  core.info(`Running: apm ${args.join(' ')}`);
  const rc = await exec.exec('apm', args, {
    cwd: resolvedDir,
    ignoreReturnCode: true,
    env: { ...process.env as Record<string, string> },
  });
  if (rc !== 0) {
    throw new Error(`apm pack failed with exit code ${rc}`);
  }

  // Find the produced bundle in build/
  const bundlePath = findBundle(buildDir, opts.archive);
  core.info(`Bundle produced: ${bundlePath}`);
  return { bundlePath, format: opts.format };
}

/**
 * Find the bundle output in the build directory.
 * For archives: look for .tar.gz files.
 * For directories: look for non-hidden directories.
 */
function findBundle(buildDir: string, archive: boolean): string {
  if (!fs.existsSync(buildDir)) {
    throw new Error(`Build directory not found: ${buildDir}`);
  }

  const entries = fs.readdirSync(buildDir);

  if (archive) {
    const archives = entries.filter(e => e.endsWith('.tar.gz')).sort();
    if (archives.length === 0) {
      throw new Error('No .tar.gz archive found in build directory after apm pack');
    }
    if (archives.length > 1) {
      throw new Error(
        `Multiple .tar.gz archives found in build directory after apm pack: ${archives.join(', ')}`,
      );
    }
    return path.join(buildDir, archives[0]);
  }

  // Directory mode: find the first non-hidden directory
  const dirs = entries.filter(e => {
    if (e.startsWith('.')) return false;
    return fs.statSync(path.join(buildDir, e)).isDirectory();
  }).sort();
  if (dirs.length === 0) {
    throw new Error('No bundle directory found in build directory after apm pack');
  }
  if (dirs.length > 1) {
    throw new Error(
      `Multiple bundle directories found in build directory after apm pack: ${dirs.join(', ')}`,
    );
  }
  return path.join(buildDir, dirs[0]);
}

/**
 * Count deployed primitive files under .github/ for reporting.
 */
function countDeployedFiles(rootDir: string): number {
  const githubDir = path.join(rootDir, '.github');
  const claudeDir = path.join(rootDir, '.claude');
  let count = 0;

  for (const dir of [githubDir, claudeDir]) {
    if (fs.existsSync(dir)) {
      count += countFilesRecursive(dir);
    }
  }
  return count;
}

function countFilesRecursive(dir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countFilesRecursive(fullPath);
    } else {
      count++;
    }
  }
  return count;
}
