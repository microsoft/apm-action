export interface ExtractResult {
    files: number;
    verified: boolean;
}
/**
 * Resolve a local bundle path (may contain glob patterns) to a single file.
 * Errors if zero or multiple files match.
 */
export declare function resolveLocalBundle(pattern: string, workspaceDir: string): Promise<string>;
/**
 * Extract a bundle into the output directory.
 * Prefers `apm unpack` (with verification) if APM is available,
 * falls back to `tar xzf` otherwise.
 */
export declare function extractBundle(bundlePath: string, outputDir: string): Promise<ExtractResult>;
/**
 * Run `apm pack` after install and return the path to the produced bundle.
 */
export declare function runPackStep(workingDir: string, opts: {
    target?: string;
    archive: boolean;
}): Promise<string>;
