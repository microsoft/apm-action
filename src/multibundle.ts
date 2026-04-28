// Gap #1 resolution: `apm unpack --dry-run` IS available in the installed apm CLI
// (verified via `apm unpack --help` during Phase 2). However, full collision
// detection across N bundles is deferred to a follow-up PR per the design plan;
// `previewBundleFiles` is therefore stubbed to return an empty CollisionReport.
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as path from 'path';

/** Env-var denylist stripped from the apm unpack subprocess (B7). */
export const TOKEN_ENV_DENYLIST: readonly string[] = [
  'GITHUB_APM_PAT',
  'ADO_APM_PAT',
  'GITHUB_TOKEN',
];

/** Default cap on the number of bundles a single list file may contain (B5). */
export const DEFAULT_MAX_BUNDLES = 64;

/** Options for parsing a bundle list file. */
export interface ParseOptions {
  /**
   * Maximum number of bundles allowed.
   * Defaults to APM_MAX_BUNDLES env var, then DEFAULT_MAX_BUNDLES (64).
   */
  maxBundles?: number;
  /**
   * Directory to resolve relative paths against.
   * Defaults to GITHUB_WORKSPACE or cwd.
   */
  workspaceDir?: string;
}

/** A single collision between two bundles deploying the same target file. */
export interface FileCollision {
  /** Relative target path inside the workspace (e.g. ".github/skills/foo/SKILL.md"). */
  targetPath: string;
  /** Absolute path of the bundle that was overwritten (earlier in list). */
  overwrittenBundle: string;
  /** Absolute path of the bundle that won (later in list). */
  winningBundle: string;
}

/** Collision report from a multi-bundle preview or restore. */
export interface CollisionReport {
  /** Files deployed by multiple bundles with byte-identical content. */
  sameSha: FileCollision[];
  /** Files deployed by multiple bundles with DIFFERENT content (last wins). */
  differentSha: FileCollision[];
}

/** Result of a multi-bundle restore operation. */
export interface RestoreResult {
  /** Number of bundles successfully restored. */
  count: number;
  /** Collision report (populated during restore). */
  collisions: CollisionReport;
}

/**
 * Build a sanitised env for the apm unpack subprocess: process.env with the
 * token denylist removed. Defence-in-depth so a malicious bundle's lifecycle
 * hooks (if any are ever introduced) cannot exfiltrate the runner's auth.
 */
export function buildStrippedEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of TOKEN_ENV_DENYLIST) {
    delete env[key];
  }
  return env;
}

/**
 * Parse a newline-separated bundle list file into validated, deduped paths.
 *
 * Rules:
 * - File must exist and be readable (hard error with path + cwd).
 * - UTF-8 only (hard error on decode failure).
 * - Lines starting with '#' are comments (skipped).
 * - Blank lines are skipped.
 * - '..' segment in any path -> reject with line number (B3).
 * - Relative paths resolved against opts.workspaceDir; rejected if they escape it (B1).
 * - Absolute paths allowed (matches existing bundle: behaviour, B1).
 * - Empty list after stripping -> hard error.
 * - Duplicates deduped silently (first occurrence wins).
 * - Cap at opts.maxBundles (default 64, env APM_MAX_BUNDLES) (B5).
 */
export function parseBundleListFile(filePath: string, opts?: ParseOptions): string[] {
  const cwd = process.cwd();
  const resolvedListPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

  if (!fs.existsSync(resolvedListPath)) {
    throw new Error(
      `bundles-file not found: ${filePath} (resolved: ${resolvedListPath}, cwd: ${cwd})`,
    );
  }

  // Read as Buffer first so we can validate UTF-8 (B2).
  let raw: Buffer;
  try {
    raw = fs.readFileSync(resolvedListPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`bundles-file unreadable: ${resolvedListPath}: ${msg}`);
  }

  // Strict UTF-8 decode using TextDecoder with fatal: true.
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new Error(
      `bundles-file is not valid UTF-8: ${resolvedListPath}`,
    );
  }

  const workspaceDir = opts?.workspaceDir
    ?? process.env.GITHUB_WORKSPACE
    ?? cwd;
  const resolvedWorkspace = path.resolve(workspaceDir);

  const envCap = parseInt(process.env.APM_MAX_BUNDLES || '', 10);
  const maxBundles = Number.isFinite(envCap) && envCap > 0
    ? envCap
    : (opts?.maxBundles ?? DEFAULT_MAX_BUNDLES);

  const lines = content.split(/\r?\n/);
  const seen = new Set<string>();
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;

    // Reject any '..' segment before resolving (B3). Normalise both '/' and '\'.
    const segments = trimmed.split(/[\\/]+/);
    if (segments.some(seg => seg === '..')) {
      throw new Error(
        `bundles-file line ${lineNum}: rejected '..' segment in path: ${trimmed}`,
      );
    }

    const isAbs = path.isAbsolute(trimmed);
    const resolved = isAbs ? path.resolve(trimmed) : path.resolve(resolvedWorkspace, trimmed);

    // Workspace escape check (B1) -- relative paths only. Absolute paths are
    // user-explicit and allowed outside the workspace (mirrors bundler.ts).
    if (!isAbs) {
      const rel = path.relative(resolvedWorkspace, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(
          `bundles-file line ${lineNum}: relative path escapes workspace ${resolvedWorkspace}: ${trimmed}`,
        );
      }
    }

    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }

  if (result.length === 0) {
    throw new Error(
      `bundles-file is empty after stripping comments and blank lines: ${resolvedListPath}`,
    );
  }
  if (result.length > maxBundles) {
    throw new Error(
      `bundles-file contains ${result.length} bundles (max ${maxBundles})`,
    );
  }

  return result;
}

/**
 * Preview file collisions across N bundles without extracting.
 *
 * NOTE: Stubbed for v1 -- returns an empty CollisionReport. Full implementation
 * (which would shell out to `apm unpack --dry-run` and aggregate file lists
 * across bundles) is deferred to a follow-up PR. The restore loop is not
 * blocked on this; collisions are still resolved by last-wins overwrite.
 */
export async function previewBundleFiles(
  bundles: string[],
): Promise<CollisionReport> {
  void bundles;
  core.debug('previewBundleFiles: dry-run aggregation not yet implemented; returning empty report');
  return { sameSha: [], differentSha: [] };
}

/**
 * Restore N bundles into the same workspace directory, in caller-specified order.
 *
 * - Verifies `apm` is on PATH (B4: hard fail, no fallback).
 * - Loops through bundles in order, calling `apm unpack <bundle> -o <outputDir>`.
 * - Subprocess env has GITHUB_APM_PAT, ADO_APM_PAT, GITHUB_TOKEN stripped (B7).
 * - Subprocess uses argv array, not shell string (B8).
 * - Fail-fast: if bundle K fails, throw with index K, path, and stderr.
 * - Returns count + empty CollisionReport (collision detection deferred).
 *
 * @param bundles   Ordered array of absolute bundle paths (from parseBundleListFile).
 * @param outputDir Workspace directory to restore into.
 */
export async function restoreMultiBundles(
  bundles: string[],
  outputDir: string,
): Promise<RestoreResult> {
  // B4: hard-fail if apm is not on PATH. Caller is expected to have invoked
  // ensureApmInstalled() already; this is a defensive check, not a fallback.
  const apmAvailable = await exec.exec('apm', ['--version'], {
    ignoreReturnCode: true,
    silent: true,
  }).catch(() => 1) === 0;

  if (!apmAvailable) {
    throw new Error(
      'apm CLI not found on PATH. Multi-bundle restore requires APM to be installed; '
      + 'ensure ensureApmInstalled() ran before restoreMultiBundles().',
    );
  }

  const resolvedOutput = path.resolve(outputDir);
  const env = buildStrippedEnv();
  const total = bundles.length;

  for (let i = 0; i < total; i++) {
    const bundle = bundles[i];
    const human = `bundle ${i + 1} of ${total}`;
    core.info(`[${human}] Unpacking: ${bundle}`);

    let stderr = '';
    const rc = await exec.exec('apm', ['unpack', bundle, '-o', resolvedOutput], {
      ignoreReturnCode: true,
      env,
      listeners: {
        stderr: (data: Buffer) => { stderr += data.toString(); },
      },
    });

    if (rc !== 0) {
      const tail = stderr.trim().split(/\r?\n/).slice(-10).join('\n');
      throw new Error(
        `apm unpack failed for ${human} (path: ${bundle}, exit code: ${rc})`
        + (tail ? `\nstderr:\n${tail}` : ''),
      );
    }
  }

  return {
    count: total,
    collisions: { sameSha: [], differentSha: [] },
  };
}
