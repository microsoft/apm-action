import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

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
export function resolveReleaseTag(
  inputTag: string,
  envRefName: string | undefined,
): string {
  const fromInput = inputTag.trim();
  if (fromInput) return fromInput;
  const fromEnv = (envRefName ?? '').trim();
  if (fromEnv) return fromEnv;
  throw new Error(
    `Cannot resolve release tag: 'release-tag' input is empty and `
    + `GITHUB_REF_NAME is not set. Pass release-tag explicitly or trigger `
    + `the workflow on a tag push (on.push.tags).`,
  );
}

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
export function sanitizeTagForPath(tag: string): string {
  let cleaned = (tag ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-');
  // Collapse runs of dots (`..`, `...`) -- they have no legitimate use
  // in a version string and produce ugly filenames. Defense-in-depth.
  cleaned = cleaned.replace(/\.{2,}/g, '.');
  // Drop dots and dashes adjacent to separators so `v1-.-v2` becomes
  // `v1-v2` and `..-foo` becomes `foo`.
  cleaned = cleaned.replace(/-\.+-/g, '-').replace(/-\.+|\.+-/g, '-');
  // Trim leading/trailing dots and dashes.
  cleaned = cleaned.replace(/^[.\-]+|[.\-]+$/g, '');
  // Collapse runs of dashes left behind.
  cleaned = cleaned.replace(/-+/g, '-');
  return cleaned || 'unversioned';
}

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
export function detectShape(workingDir: string): RepoShape {
  const pluginsDir = path.join(workingDir, 'plugins');
  if (!fs.existsSync(pluginsDir) || !fs.statSync(pluginsDir).isDirectory()) {
    return 'single-plugin';
  }
  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginYml = path.join(pluginsDir, entry.name, 'apm.yml');
    if (fs.existsSync(pluginYml)) {
      return 'aggregator';
    }
  }
  return 'single-plugin';
}

/**
 * Read `name` and `version` from an apm.yml without imposing a schema --
 * just enough to drive matrix iteration and artifact naming.
 */
function readApmYml(apmYmlPath: string): { name: string; version: string } {
  if (!fs.existsSync(apmYmlPath)) {
    throw new Error(`apm.yml not found at ${apmYmlPath}`);
  }
  const raw = fs.readFileSync(apmYmlPath, 'utf8');
  const parsed = yaml.load(raw) as { name?: unknown; version?: unknown } | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`apm.yml at ${apmYmlPath} is empty or not an object`);
  }
  const name = String(parsed.name ?? '').trim();
  const version = String(parsed.version ?? '').trim();
  if (!name) {
    throw new Error(`apm.yml at ${apmYmlPath} is missing 'name'`);
  }
  if (!version) {
    throw new Error(`apm.yml at ${apmYmlPath} is missing 'version'`);
  }
  return { name, version };
}

/**
 * Discover the packages to release.
 *   aggregator    -> one entry per plugin under plugins/.
 *   single-plugin -> one entry for the top-level apm.yml.
 */
export function discoverPackages(
  workingDir: string,
  shape: RepoShape,
): { name: string; version: string; dir: string }[] {
  if (shape === 'single-plugin') {
    const meta = readApmYml(path.join(workingDir, 'apm.yml'));
    return [{ ...meta, dir: workingDir }];
  }
  const pluginsDir = path.join(workingDir, 'plugins');
  const out: { name: string; version: string; dir: string }[] = [];
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(pluginsDir, entry.name);
    const apmYml = path.join(dir, 'apm.yml');
    if (!fs.existsSync(apmYml)) continue;
    const meta = readApmYml(apmYml);
    out.push({ ...meta, dir });
  }
  if (out.length === 0) {
    throw new Error(
      `No packages found under ${pluginsDir}. Expected one or more `
      + `plugins/<name>/apm.yml files (aggregator layout).`,
    );
  }
  return out;
}

/**
 * Decide prerelease=true|false. `auto` -> true when the tag contains `-`
 * (semver pre-release suffix), false otherwise. This matches `gh release
 * create --prerelease` semantics in the most common workflow shape.
 */
export function resolvePrerelease(
  mode: 'true' | 'false' | 'auto',
  tag: string,
): boolean {
  if (mode === 'true') return true;
  if (mode === 'false') return false;
  // auto: a hyphen after the version (e.g. v1.2.3-rc.1) -> prerelease.
  // Strip a leading v/V to keep things obvious for the operator who
  // reads the trace.
  const stripped = tag.replace(/^v/i, '');
  const m = stripped.match(/^[0-9]+\.[0-9]+\.[0-9]+(.*)$/);
  if (!m) return false;
  return m[1].startsWith('-');
}

/**
 * Run the validation gate: `apm pack --check-versions --check-clean --json`.
 * Surfaces version misalignment (exit 3) and marketplace drift (exit 4)
 * as actionable failures with the JSON envelope rendered into the step
 * summary.
 *
 * Returns the parsed envelope so callers can branch on `drift` if needed.
 */
export async function runGate(
  workingDir: string,
): Promise<{ drift: boolean; envelope: unknown }> {
  const tmpJson = path.join(workingDir, '.apm-pack-report.json');
  // Always start clean so a stale report from a previous run never lies.
  try { fs.unlinkSync(tmpJson); } catch { /* ignore */ }

  const args = [
    'pack',
    '--check-versions',
    '--check-clean',
    '--json',
  ];
  core.info(`Running gate: apm ${args.join(' ')}`);

  let stdoutBuf = '';
  let stderrBuf = '';
  const rc = await exec.exec('apm', args, {
    cwd: workingDir,
    ignoreReturnCode: true,
    silent: true,
    listeners: {
      stdout: (data: Buffer) => { stdoutBuf += data.toString('utf8'); },
      stderr: (data: Buffer) => { stderrBuf += data.toString('utf8'); process.stderr.write(data); },
    },
  });

  // Persist for diagnostics + downstream steps.
  if (stdoutBuf) {
    try { fs.writeFileSync(tmpJson, stdoutBuf); } catch { /* ignore */ }
  }

  let envelope: unknown = null;
  try {
    envelope = stdoutBuf ? JSON.parse(stdoutBuf) : null;
  } catch {
    envelope = null;
  }

  if (rc === 0) {
    return { drift: false, envelope };
  }

  // Exit code semantics from apm pack (Wave 4):
  //   3 = version misalignment (--check-versions failed)
  //   4 = drift (--check-clean failed)
  // Anything else = generic pack failure.
  if (rc === 3) {
    throw new Error(
      `apm pack --check-versions detected misaligned versions. `
      + `Reconcile your apm.yml(s) and tag_pattern before releasing. `
      + `See the JSON envelope above (or .apm-pack-report.json) for the `
      + `specific mismatch.`,
    );
  }
  if (rc === 4) {
    // Caller still needs to know about drift even on failure, so the
    // output gets set before throwing.
    core.setOutput('marketplace-drift', 'true');
    throw new Error(
      `apm pack --check-clean detected uncommitted marketplace drift. `
      + `Re-run 'apm pack' locally and commit the regenerated marketplace `
      + `files before releasing. See the JSON envelope (or `
      + `.apm-pack-report.json) for the diff.`,
    );
  }
  throw new Error(
    `apm pack gate failed with exit code ${rc}. stderr:\n${stderrBuf}`,
  );
}

/**
 * Pack a single package: `cd <dir> && apm pack --offline --archive -o <dist>`.
 * Returns the absolute path to the produced .tar.gz.
 *
 * Selects the produced tarball by mtime (newest after pack) rather than
 * diffing the directory before/after. This is robust to the case where
 * `apm pack` overwrites an existing tarball of the same name -- the diff
 * approach would see fresh=[] and incorrectly throw despite pack succeeding.
 */
export async function packPackage(
  dir: string,
  distDir: string,
): Promise<string> {
  fs.mkdirSync(distDir, { recursive: true });
  const packStartMs = Date.now();
  const rc = await exec.exec('apm', [
    'pack',
    '--offline',
    '--archive',
    '-o', distDir,
  ], { cwd: dir, ignoreReturnCode: true });
  if (rc !== 0) {
    throw new Error(`apm pack failed for ${dir} (exit ${rc})`);
  }
  const after = listTarballs(distDir);
  if (after.length === 0) {
    throw new Error(
      `apm pack in ${dir} succeeded but produced no .tar.gz in ${distDir}. `
      + `Verify that the package has a 'dependencies:' block or primitives `
      + `to bundle.`,
    );
  }
  // listTarballs sorts newest-first by mtime. Accept the newest tarball
  // whose mtime is >= packStart (1s grace for fs mtime granularity).
  const graceMs = packStartMs - 1000;
  const fresh = after.filter(p => fs.statSync(p).mtimeMs >= graceMs);
  if (fresh.length === 0) {
    throw new Error(
      `apm pack in ${dir} succeeded but no tarball in ${distDir} has an `
      + `mtime newer than the pack invocation. Filesystem clock skew?`,
    );
  }
  if (fresh.length > 1) {
    core.warning(
      `apm pack in ${dir} produced ${fresh.length} tarballs; expected 1. `
      + `Using the most recently modified: ${fresh[0]}`,
    );
  }
  return fresh[0];
}

function listTarballs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(n => n.endsWith('.tar.gz'))
    .map(n => path.join(dir, n))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

/**
 * Compute sha256 of a file and write a sidecar in `sha256sum`-compatible
 * format ('<hex>  <basename>\n'), returning the sidecar path and hex digest.
 */
export function writeSha256Sidecar(filePath: string): { hex: string; sidecar: string } {
  const buf = fs.readFileSync(filePath);
  const hex = crypto.createHash('sha256').update(buf).digest('hex');
  const sidecar = filePath + '.sha256';
  // sha256sum format: '<hex>  <basename>\n' (two spaces between fields).
  fs.writeFileSync(sidecar, `${hex}  ${path.basename(filePath)}\n`);
  return { hex, sidecar };
}

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
export function stageMarketplaceJson(
  workingDir: string,
  distDir: string,
  version: string,
): string | null {
  const candidates = [
    path.join(workingDir, '.claude-plugin', 'marketplace.json'),
    path.join(workingDir, '.codex-plugin', 'marketplace.json'),
    path.join(workingDir, 'marketplace.json'),
  ];
  for (const src of candidates) {
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(distDir, { recursive: true });
    const dst = path.join(distDir, `marketplace-${version}.json`);
    fs.copyFileSync(src, dst);
    core.info(`Staged ${src} -> ${dst}`);
    return dst;
  }
  return null;
}

function renderStepSummary(
  shape: RepoShape,
  tag: string,
  packages: PackagedArtifact[],
  marketplacePath: string | null,
  skipPublish: boolean,
): string {
  const rows = packages.map(p =>
    `| \`${p.name}\` | \`${p.version}\` | \`${path.basename(p.bundle)}\` | \`${p.sha256.slice(0, 12)}...\` |`,
  ).join('\n');
  const marketplaceLine = marketplacePath
    ? `**Marketplace asset:** \`${path.basename(marketplacePath)}\``
    : `**Marketplace asset:** (none -- single-plugin shape)`;
  const publishLine = skipPublish
    ? `**Publish:** skipped (release-skip-publish=true)`
    : `**Publish:** gh release create ${tag}`;
  return [
    `## APM release \`${tag}\``,
    ``,
    `**Shape:** ${shape}  *  **Packages:** ${packages.length}`,
    ``,
    marketplaceLine,
    ``,
    publishLine,
    ``,
    `| package | version | bundle | sha256 |`,
    `|---|---|---|---|`,
    rows,
    ``,
  ].join('\n');
}

/**
 * Generate a default release body when the caller did not provide one.
 */
function renderDefaultReleaseNotes(
  packages: PackagedArtifact[],
  marketplacePath: string | null,
): string {
  const rows = packages.map(p =>
    `| \`${p.name}\` | \`${p.version}\` | \`${path.basename(p.bundle)}\` | \`${p.sha256}\` |`,
  ).join('\n');
  const marketplaceLine = marketplacePath
    ? `\nMarketplace manifest: \`${path.basename(marketplacePath)}\`\n`
    : ``;
  return [
    `## Packages`,
    ``,
    `| package | version | bundle | sha256 |`,
    `|---|---|---|---|`,
    rows,
    marketplaceLine,
    `Verify any download with \`sha256sum -c <bundle>.sha256\`.`,
  ].join('\n');
}

/**
 * Execute the release pipeline. See ReleaseOptions for parameters.
 */
export async function runReleaseMode(opts: ReleaseOptions): Promise<ReleaseResult> {
  const workingDir = path.resolve(opts.workingDir);
  if (!fs.existsSync(workingDir)) {
    throw new Error(`Working directory does not exist: ${workingDir}`);
  }

  // dist/ lives under GITHUB_WORKSPACE when available, else under workingDir.
  // Putting it under WORKSPACE matches the zava convention and ensures the
  // file paths in outputs.packages are stable across reusable workflows.
  const workspace = process.env.GITHUB_WORKSPACE
    ? path.resolve(process.env.GITHUB_WORKSPACE)
    : workingDir;
  const distDir = path.join(workspace, 'dist');
  fs.mkdirSync(distDir, { recursive: true });

  const tag = opts.releaseTag;
  core.info(`Resolved release tag: ${tag}`);

  const shape = detectShape(workingDir);
  core.info(`Detected repo shape: ${shape}`);

  // 1. Gate
  let drift = false;
  try {
    const gate = await runGate(workingDir);
    drift = gate.drift;
  } catch (err) {
    // Surface gate failure cleanly; rethrow to let runner.run() catch it.
    throw err;
  }

  // 2. Matrix pack
  const packages = discoverPackages(workingDir, shape);
  core.info(`Packing ${packages.length} package(s)...`);
  const results: PackagedArtifact[] = [];
  for (const pkg of packages) {
    const bundle = await packPackage(pkg.dir, distDir);
    const { hex, sidecar } = writeSha256Sidecar(bundle);
    results.push({
      name: pkg.name,
      version: pkg.version,
      bundle,
      sha256: hex,
      sha256_path: sidecar,
    });
    core.info(`Packed ${pkg.name}@${pkg.version}: ${path.basename(bundle)} (${hex.slice(0, 12)}...)`);
  }

  // 3. Stage marketplace.json (aggregator only, typically)
  // Pick the highest semver-ish version among packages for the suffix when
  // there is no top-level package; fall back to the tag. Sanitize because
  // git tags can include `/`, `..` and other path-delimiter bytes that
  // would let an attacker-controlled tag escape distDir.
  const rawVersion =
    tag.replace(/^v/i, '') || results.map(r => r.version).sort().pop() || 'unversioned';
  const marketplaceVersion = sanitizeTagForPath(rawVersion);
  const marketplacePath = stageMarketplaceJson(workingDir, distDir, marketplaceVersion);

  // 4. Step summary (best-effort; never fails the run)
  try {
    const summary = renderStepSummary(shape, tag, results, marketplacePath, opts.skipPublish);
    await core.summary.addRaw(summary).write();
  } catch (err) {
    core.warning(`Could not write step summary: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. Publish (or skip)
  let releaseUrl = '';
  if (!opts.skipPublish) {
    const prerelease = resolvePrerelease(opts.releasePrerelease, tag);
    const notes = opts.releaseNotes.trim() || renderDefaultReleaseNotes(results, marketplacePath);

    // Files to attach: every .tar.gz, every .sha256 sidecar, the
    // marketplace.json (when present). Pass each path positionally; gh
    // CLI handles globless lists fine and we already know the exact set.
    const files: string[] = [];
    for (const r of results) {
      files.push(r.bundle);
      files.push(r.sha256_path);
    }
    if (marketplacePath) files.push(marketplacePath);

    // Write notes to a tmp file so we don't fight `gh`'s argument escaping
    // for multi-line content. Sanitize the tag for the filename only --
    // git tags can contain `/` or `..`; the original `tag` value is still
    // passed to `gh release create` below so the actual release is created
    // against the real ref.
    const notesFile = path.join(distDir, `.release-notes-${sanitizeTagForPath(tag)}.md`);
    fs.writeFileSync(notesFile, notes);

    const ghArgs = ['release', 'create', tag, '--notes-file', notesFile];
    if (opts.releaseName.trim()) {
      ghArgs.push('--title', opts.releaseName.trim());
    } else {
      ghArgs.push('--title', tag);
    }
    if (opts.releaseDraft) ghArgs.push('--draft');
    if (prerelease) ghArgs.push('--prerelease');
    ghArgs.push(...files);

    core.info(`Publishing release: gh ${ghArgs.join(' ')}`);
    let urlBuf = '';
    const rc = await exec.exec('gh', ghArgs, {
      cwd: workingDir,
      ignoreReturnCode: true,
      listeners: {
        stdout: (data: Buffer) => { urlBuf += data.toString('utf8'); },
      },
    });
    if (rc !== 0) {
      throw new Error(`gh release create failed (exit ${rc}).`);
    }
    // gh release create prints the release URL to stdout.
    releaseUrl = urlBuf.trim().split('\n').pop()?.trim() ?? '';
  } else {
    core.info(`release-skip-publish=true -- not invoking gh release create`);
  }

  return {
    packages: results,
    marketplaceDrift: drift,
    releaseUrl,
    releaseTag: tag,
  };
}
