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
/**
 * Ensure APM CLI is installed and available on the runner.
 * Uses @actions/tool-cache for downloading, extracting, and caching.
 */
export declare function ensureApmInstalled(): Promise<void>;
