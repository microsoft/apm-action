/**
 * Env-var denylist stripped from the apm unpack subprocess (B7).
 *
 * Includes:
 * - APM-recognised credentials: GITHUB_APM_PAT, ADO_APM_PAT.
 * - GitHub CLI / Actions token aliases that APM may auto-detect now or in
 *   future releases: GITHUB_TOKEN, GH_TOKEN.
 * - Runner-scoped tokens with high blast radius if exfiltrated by a malicious
 *   bundle's hypothetical lifecycle hook: ACTIONS_RUNTIME_TOKEN (cache write),
 *   ACTIONS_ID_TOKEN_REQUEST_TOKEN (OIDC federation).
 *
 * Defence-in-depth: `apm unpack` itself does not need any of these, and the
 * restore-side multi-bundle path performs no authenticated network calls.
 */
export declare const TOKEN_ENV_DENYLIST: readonly string[];
/** Default cap on the number of bundles a single list file may contain (B5). */
export declare const DEFAULT_MAX_BUNDLES = 64;
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
export declare function buildStrippedEnv(): Record<string, string>;
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
 * - Each entry must end in `.tar.gz` (defence-in-depth + clear early failure
 *   if a user accidentally points at a directory or wrong file). Glob patterns
 *   are NOT expanded; use `find ... | sort` to generate the list yourself.
 * - Empty list after stripping -> hard error.
 * - Duplicates deduped silently (first occurrence wins).
 * - Cap at opts.maxBundles (default 64, env APM_MAX_BUNDLES) (B5).
 */
export declare function parseBundleListFile(filePath: string, opts?: ParseOptions): string[];
/**
 * Preview file collisions across N bundles without extracting.
 *
 * NOTE: Stubbed for v1.5.0 -- returns an empty CollisionReport. Full
 * implementation (which would shell out to `apm unpack --dry-run` and
 * aggregate file lists across bundles, distinguishing same-SHA from
 * different-SHA overlaps) is planned for v1.6.0. The restore loop is NOT
 * blocked on this; the policy is documented up-front via
 * `logCollisionPolicy()` so users are not surprised by silent overwrites.
 *
 * The function is wired into the runner today so its call site is real,
 * not dead code -- the v1.6.0 follow-up only swaps the implementation.
 */
export declare function previewBundleFiles(bundles: string[]): Promise<CollisionReport>;
/**
 * Emit a single, explicit policy banner BEFORE the restore loop runs so the
 * user is never surprised by silent overwrites. No-op for the single-bundle
 * case (no possible collisions). Intentionally `core.warning` not `core.info`
 * so it is annotated visibly in the GitHub Actions summary.
 */
export declare function logCollisionPolicy(bundleCount: number): void;
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
export declare function restoreMultiBundles(bundles: string[], outputDir: string): Promise<RestoreResult>;
