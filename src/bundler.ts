import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as glob from '@actions/glob';
import * as fs from 'fs';
import * as path from 'path';

export interface ExtractResult {
  files: number;
  verified: boolean;
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

  const bundlePath = matches[0];

  // Path traversal protection: ensure resolved path is within workspace
  if (!path.resolve(bundlePath).startsWith(resolvedWorkspace)) {
    throw new Error(`Bundle path "${pattern}" resolves outside the workspace`);
  }

  return bundlePath;
}

/**
 * Extract a bundle into the output directory.
 * Prefers `apm unpack` (with verification) if APM is available,
 * falls back to `tar xzf` otherwise.
 */
export async function extractBundle(bundlePath: string, outputDir: string): Promise<ExtractResult> {
  const resolvedBundle = path.resolve(bundlePath);
  const resolvedOutput = path.resolve(outputDir);

  if (!fs.existsSync(resolvedBundle)) {
    throw new Error(`Bundle not found: ${bundlePath}`);
  }

  // Try apm unpack first (provides verification)
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
    return { files, verified: true };
  }

  // Fallback: tar extraction
  core.info('APM not available — extracting with tar (no verification)...');
  const rc = await exec.exec('tar', ['xzf', resolvedBundle, '-C', resolvedOutput, '--strip-components=1'], {
    ignoreReturnCode: true,
  });
  if (rc !== 0) {
    throw new Error(`tar extraction failed with exit code ${rc}`);
  }
  const files = countDeployedFiles(resolvedOutput);
  return { files, verified: false };
}

/**
 * Run `apm pack` after install and return the path to the produced bundle.
 */
export async function runPackStep(
  workingDir: string,
  opts: { target?: string; archive: boolean },
): Promise<string> {
  const resolvedDir = path.resolve(workingDir);
  const buildDir = path.join(resolvedDir, 'build');

  const args = ['pack', '-o', buildDir];
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
  return bundlePath;
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
    const archives = entries.filter(e => e.endsWith('.tar.gz'));
    if (archives.length === 0) {
      throw new Error('No .tar.gz archive found in build directory after apm pack');
    }
    return path.join(buildDir, archives[0]);
  }

  // Directory mode: find the first non-hidden directory
  const dirs = entries.filter(e => {
    if (e.startsWith('.')) return false;
    return fs.statSync(path.join(buildDir, e)).isDirectory();
  });
  if (dirs.length === 0) {
    throw new Error('No bundle directory found in build directory after apm pack');
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
