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
export declare function resolveLocalBundle(pattern: string, workspaceDir: string): Promise<string>;
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
export declare function detectBundleFormat(bundlePath: string): Promise<BundleFormat>;
export declare function extractBundle(bundlePath: string, outputDir: string): Promise<ExtractResult>;
/**
 * Run `apm pack` after install and return the path to the produced bundle
 * along with the format that was used.
 */
export declare function runPackStep(workingDir: string, opts: {
    target?: string;
    archive: boolean;
    format: BundleFormat;
}): Promise<{
    bundlePath: string;
    format: BundleFormat;
}>;
