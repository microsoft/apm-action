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
export interface PackOptions {
    target?: string;
    archive: boolean;
    format: BundleFormat;
    /**
     * Value for `apm pack --marketplace=<value>`. Accepts a comma-separated
     * list of format names ('claude,codex'), 'all', or 'none'. Forwarded
     * verbatim to the CLI.
     */
    marketplace?: string;
    /**
     * Repeatable `--marketplace-path FORMAT=PATH` overrides. Each element
     * must already be in `FORMAT=PATH` shape (the runner parses caller
     * input into this list).
     */
    marketplacePath?: string[];
    /** Forward `--offline` to skip network resolution of marketplace refs. */
    offline?: boolean;
    /** Forward `--include-prerelease` to consider pre-release version tags. */
    includePrerelease?: boolean;
    /**
     * When set, pass `--json` to `apm pack` and capture stdout to this path.
     * The CLI routes human-readable logs to stderr in this mode.
     */
    jsonOutput?: string;
}
export interface PackResult {
    /**
     * Path to the produced bundle, or null when the project produced only
     * marketplace artifacts (no `dependencies:` block in apm.yml). Callers
     * that need the bundle should error on null; callers that drive
     * marketplace-only releases should consume `marketplaceJsonPath`.
     */
    bundlePath: string | null;
    format: BundleFormat;
    /**
     * Path to the captured `--json` stdout when `jsonOutput` was set,
     * otherwise null. Always populated when the JSON capture succeeded,
     * regardless of bundle presence.
     */
    marketplaceJsonPath: string | null;
}
/**
 * Run `apm pack` after install and return the path to the produced bundle
 * (when one was produced) along with the format and the optional JSON
 * report path.
 */
export declare function runPackStep(workingDir: string, opts: PackOptions): Promise<PackResult>;
