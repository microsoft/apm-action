/**
 * Options for the `mode: release` umbrella.
 *
 * The release pipeline is a GH-Actions convenience wrapper over the
 * vendor-neutral CLI primitives:
 *   1. apm pack --check-versions --check-clean --json  (gate)
 *   2. apm pack --offline --archive                     (per-package matrix)
 *   3. sha256sum                                        (per-tarball sidecar)
 *   4. gh release create                                (publish)
 *
 * Each step has a CLI equivalent that works on Jenkins, GitLab, ADO, etc.
 * See docs/producer/releasing-from-any-ci.md.
 */
export interface ReleaseOptions {
    workingDir: string;
    releaseTag: string;
    releaseName: string;
    releaseNotes: string;
    releaseDraft: boolean;
    releasePrerelease: 'true' | 'false' | 'auto';
    skipPublish: boolean;
}
export interface PackagedArtifact {
    name: string;
    version: string;
    bundle: string;
    sha256: string;
    sha256_path: string;
}
export interface ReleaseResult {
    packages: PackagedArtifact[];
    marketplaceDrift: boolean;
    releaseUrl: string;
    releaseTag: string;
}
/** Shape detected from the project layout. */
type RepoShape = 'aggregator' | 'single-plugin';
/**
 * Resolve the release tag. Explicit input wins; otherwise fall back to
 * GITHUB_REF_NAME (set automatically when triggered by a tag push).
 */
export declare function resolveReleaseTag(inputTag: string, envRefName: string | undefined): string;
/**
 * Sanitize a release tag for safe use in a file or directory name.
 *
 * Git tag names can legally include `/`, `..`, control characters, and
 * other path-delimiter bytes (the Git ref grammar bans only a small
 * subset). Using a raw tag inside `path.join(...)` can write outside the
 * intended dist/ tree (path traversal) or create unintended subdirs.
 *
 * Allow only `[A-Za-z0-9._-]`; collapse every other byte to `-`. Strip
 * leading dots so the result cannot be `..` or `.hidden`. Empty input
 * (or input that sanitizes to empty) returns `unversioned`.
 *
 * IMPORTANT: callers must still pass the ORIGINAL tag to `gh release create`
 * -- sanitization is purely for local filesystem paths.
 */
export declare function sanitizeTagForPath(tag: string): string;
/**
 * Detect repository shape from the on-disk apm.yml layout.
 *
 *   aggregator    -- top-level apm.yml + plugins subdir siblings.
 *                    Each plugin under plugins/ is packed independently.
 *   single-plugin -- top-level apm.yml only.
 *
 * Heuristic: presence of one or more `plugins/<name>/apm.yml` files implies
 * aggregator. This matches the zava-agent-configs layout and the convention
 * used in microsoft/apm docs (producer/repo-shapes.md).
 */
export declare function detectShape(workingDir: string): RepoShape;
/**
 * Discover the packages to release.
 *   aggregator    -> one entry per plugin under plugins/.
 *   single-plugin -> one entry for the top-level apm.yml.
 */
export declare function discoverPackages(workingDir: string, shape: RepoShape): {
    name: string;
    version: string;
    dir: string;
}[];
/**
 * Decide prerelease=true|false. `auto` -> true when the tag contains `-`
 * (semver pre-release suffix), false otherwise. This matches `gh release
 * create --prerelease` semantics in the most common workflow shape.
 */
export declare function resolvePrerelease(mode: 'true' | 'false' | 'auto', tag: string): boolean;
/**
 * Run the validation gate: `apm pack --check-versions --check-clean --json`.
 * Surfaces version misalignment (exit 3) and marketplace drift (exit 4)
 * as actionable failures with the JSON envelope rendered into the step
 * summary.
 *
 * Returns the parsed envelope so callers can branch on `drift` if needed.
 */
export declare function runGate(workingDir: string): Promise<{
    drift: boolean;
    envelope: unknown;
}>;
/**
 * Pack a single package: `cd <dir> && apm pack --offline --archive -o <dist>`.
 * Returns the absolute path to the produced .tar.gz.
 *
 * Selects the produced tarball by mtime (newest after pack) rather than
 * diffing the directory before/after. This is robust to the case where
 * `apm pack` overwrites an existing tarball of the same name -- the diff
 * approach would see fresh=[] and incorrectly throw despite pack succeeding.
 */
export declare function packPackage(dir: string, distDir: string): Promise<string>;
/**
 * Compute sha256 of a file and write a sidecar in `sha256sum`-compatible
 * format ('<hex>  <basename>\n'), returning the sidecar path and hex digest.
 */
export declare function writeSha256Sidecar(filePath: string): {
    hex: string;
    sidecar: string;
};
/**
 * Locate the canonical marketplace.json for aggregator shape and stage
 * it into dist with a version suffix. Returns the staged path, or null
 * when no marketplace file exists (single-plugin shape typically).
 *
 * Lookup order (first match wins):
 *   1. .claude-plugin/marketplace.json
 *   2. .codex-plugin/marketplace.json
 *   3. marketplace.json (top level)
 */
export declare function stageMarketplaceJson(workingDir: string, distDir: string, version: string): string | null;
/**
 * Execute the release pipeline. See ReleaseOptions for parameters.
 */
export declare function runReleaseMode(opts: ReleaseOptions): Promise<ReleaseResult>;
export {};
