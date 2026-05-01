/**
 * Map Node.js platform/arch to the APM asset naming convention.
 */
export declare function getAssetSuffix(): string;
/**
 * Resolve the download URL for a specific APM version.
 * For 'latest', queries the GitHub Releases API (no auth needed for public repos).
 * For a pinned version, constructs the URL directly.
 */
export declare function resolveDownloadUrl(version: string): Promise<{
    url: string;
    resolvedVersion: string;
}>;
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
 * Ensure APM CLI is installed and available on the runner.
 * Uses @actions/tool-cache for downloading, extracting, and caching.
 *
 * Version semantics:
 *   - `apm-version: latest` -- if any apm is already on PATH, reuse it; else
 *     resolve the latest GitHub release and install via tool-cache.
 *   - `apm-version: <pinned>` -- always install the requested version into the
 *     tool-cache (or reuse a tool-cache hit). Never short-circuits to a random
 *     apm that happens to be on PATH; the caller asked for a specific version
 *     and gets that version.
 */
export declare function ensureApmInstalled(): Promise<InstallResult>;
