import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ensureApmInstalled } from './installer.js';
import { resolveLocalBundle, extractBundle, runPackStep } from './bundler.js';

/**
 * Run the APM action: install agent primitives.
 *
 * Default behavior (no inputs): reads apm.yml, runs apm install. Done.
 * With `dependencies` input: parses YAML array, installs each as extra deps (additive to apm.yml).
 * With `isolated: true`: clears existing primitives, ignores apm.yml, installs only inline deps.
 * With `compile: true`: runs apm compile after install to generate AGENTS.md.
 * With `script` input: runs an apm script after install.
 * With `pack: true`: runs apm pack after install to produce a bundle.
 * With `bundle` input: restores from a bundle (no APM install needed).
 */
export async function run(): Promise<void> {
  try {
    // 0. Resolve working directory and read mode flags
    const workingDir = core.getInput('working-directory') || '.';
    const resolvedDir = path.resolve(workingDir);
    const bundleInput = core.getInput('bundle').trim();
    const bundlesFileInput = core.getInput('bundles-file').trim();
    const packInput = core.getInput('pack') === 'true';
    const isolated = core.getInput('isolated') === 'true';
    const auditReportInput = core.getInput('audit-report').trim();

    // Pass github-token input to APM subprocess as GITHUB_TOKEN.
    // GitHub Actions does not auto-export input values as env vars —
    // without this, APM runs unauthenticated (rate-limited, no private repo access).
    // Use ??= so a GITHUB_TOKEN already in the environment (e.g., a PAT set via
    // job-level `env:`) is not clobbered by the action's default github.token.
    //
    // GITHUB_APM_PAT is only forwarded when GITHUB_TOKEN was NOT already present.
    // When a caller provides GITHUB_TOKEN via step/job-level env: (e.g., a GitHub
    // App token from gh-aw), that token carries higher-specificity auth than the
    // action's default github.token.  Since APM's token precedence is
    //   GITHUB_APM_PAT > GITHUB_TOKEN > GH_TOKEN
    // auto-setting GITHUB_APM_PAT to the default github.token would shadow the
    // caller's intentional GITHUB_TOKEN, causing auth failures for cross-org or
    // private-repo access.
    const githubToken = core.getInput('github-token');
    if (githubToken) {
      core.setSecret(githubToken);
      const callerProvidedToken = !!process.env.GITHUB_TOKEN;
      if (!process.env.GITHUB_TOKEN) {
        process.env.GITHUB_TOKEN = githubToken;
      }
      if (!callerProvidedToken) {
        process.env.GITHUB_APM_PAT ??= githubToken;
      }
    }

    // 3-way mutex: at most one of pack / bundle / bundles-file.
    const modeFlags = [
      packInput && 'pack',
      bundleInput && 'bundle',
      bundlesFileInput && 'bundles-file',
    ].filter(Boolean) as string[];
    if (modeFlags.length > 1) {
      throw new Error(
        `inputs 'pack', 'bundle', and 'bundles-file' are mutually exclusive `
        + `(got: ${modeFlags.join(', ')}). Pick exactly one mode per step.`,
      );
    }

    // Directory creation contract:
    //   - isolated / pack / bundle (restore) modes: the action owns the workspace
    //     lifecycle and creates the directory automatically. These modes bootstrap
    //     everything from scratch — there is no pre-existing project to find.
    //   - non-isolated mode: the caller owns the project directory (which must
    //     contain apm.yml). If it doesn't exist, we fail fast with a clear message
    //     rather than silently creating an empty directory that would just fail later.
    const actionOwnsDir = isolated || packInput || !!bundleInput || !!bundlesFileInput;
    if (actionOwnsDir) {
      fs.mkdirSync(resolvedDir, { recursive: true });
    } else if (!fs.existsSync(resolvedDir)) {
      throw new Error(
        `Working directory does not exist: ${resolvedDir}. ` +
        'In non-isolated mode the directory must already contain your project (with apm.yml). ' +
        'Use isolated: true if you want the action to create it automatically.',
      );
    }
    core.info(`Working directory: ${resolvedDir}`);

    // Resolve audit report path
    let auditReportPath: string | undefined;
    if (auditReportInput) {
      if (auditReportInput === 'true') {
        auditReportPath = path.join(resolvedDir, 'apm-audit.sarif');
      } else {
        auditReportPath = path.resolve(resolvedDir, auditReportInput);
      }
    }

    // RESTORE MODE: install APM, then extract via `apm unpack`.
    // Directory was already created above (actionOwnsDir = true for bundle mode).
    //
    // Why install APM in restore mode:
    //   `apm unpack` honors the bundle contract — it copies only files listed in
    //   the lockfile's `deployed_files` (primitives + apm_modules) and never
    //   writes `apm.lock.yaml` / `apm.yml` to `working-directory`. The previous
    //   "skip install" optimization forced extractBundle through its raw
    //   `tar xzf --strip-components=1` fallback, which dumped the *entire*
    //   bundle — including lockfile and apm.yml — into working-directory.
    //   When working-directory was a git checkout (the default
    //   `${{ github.workspace }}`), those tracked files became dirty and any
    //   subsequent `git checkout` (e.g. gh-aw's pull_request_target PR-branch
    //   checkout) aborted with:
    //     error: Your local changes to the following files would be
    //     overwritten by checkout: apm.lock.yaml
    //   See microsoft/apm-action#26.
    //
    // The install is tool-cached (see installer.ts), so this adds at most a
    // single small download per runner — negligible vs. the cost of a typical
    // agent job, and we get bundle integrity verification for free.
    if (bundleInput) {
      await ensureApmInstalled();

      const bundlePath = await resolveLocalBundle(bundleInput, resolvedDir);
      core.info(`Restoring bundle: ${bundlePath}`);
      const result = await extractBundle(bundlePath, resolvedDir);
      // Restore mode now installs APM up-front, so the verified `apm unpack`
      // path is the expected outcome. The unverified branch only runs if APM
      // install failed transiently and extractBundle fell through to its tar
      // fallback — point operators at the install logs, not at re-installing.
      const verifiedMsg = result.verified
        ? ' (verified)'
        : ' (unverified — APM install did not complete; see earlier install logs)';
      core.info(`Restored ${result.files} file(s)${verifiedMsg}`);

      const primitivesPath = path.join(resolvedDir, '.github');
      core.setOutput('primitives-path', primitivesPath);

      // Run audit on unpacked bundle if report requested
      if (auditReportPath) {
        await runAuditReport(resolvedDir, auditReportPath);
      }

      core.setOutput('success', 'true');
      core.info('APM action completed successfully (restore mode)');
      return;
    }

    // MULTI-BUNDLE RESTORE MODE
    if (bundlesFileInput) {
      const {
        parseBundleListFile,
        previewBundleFiles,
        logCollisionPolicy,
        restoreMultiBundles,
      } = await import('./multibundle.js');

      const bundles = parseBundleListFile(bundlesFileInput, {
        workspaceDir: resolvedDir,
      });
      core.info(`Multi-bundle restore: ${bundles.length} bundle(s) from ${bundlesFileInput}`);

      // Surface the collision policy BEFORE any work happens so users are
      // never surprised by silent overwrites. Wired to previewBundleFiles
      // so the call site is real today; per-file SHA collision detection
      // ships in v1.6.0 (currently a no-op stub).
      logCollisionPolicy(bundles.length);
      const preview = await previewBundleFiles(bundles);
      if (preview.differentSha.length > 0) {
        core.warning(
          `Detected ${preview.differentSha.length} different-content collision(s) `
          + `across bundles. Later bundles in the list will win.`,
        );
      }
      if (preview.sameSha.length > 0) {
        core.info(
          `Detected ${preview.sameSha.length} byte-identical file overlap(s) `
          + `across bundles (benign duplicates).`,
        );
      }

      // ensureApmInstalled() runs the install pipeline; restoreMultiBundles
      // additionally probes `apm --version` as a defence-in-depth check so
      // a transient install failure surfaces with a clear error before the
      // first unpack rather than as a generic ENOENT mid-loop.
      await ensureApmInstalled();
      const result = await restoreMultiBundles(bundles, resolvedDir);

      core.info(
        `Restored ${result.count} bundle(s) successfully into ${resolvedDir}`,
      );

      const primitivesPath = path.join(resolvedDir, '.github');
      core.setOutput('primitives-path', primitivesPath);
      core.setOutput('bundles-restored', String(result.count));

      // Run audit on merged workspace if requested
      if (auditReportPath) {
        await runAuditReport(resolvedDir, auditReportPath);
      }

      core.setOutput('success', 'true');
      core.info('APM action completed successfully (multi-bundle restore mode)');
      return;
    }

    // 1. Install APM CLI (install + pack modes)
    await ensureApmInstalled();

    // 2. Parse inputs
    const depsInput = core.getInput('dependencies').trim();

    // 3. Handle isolated mode: clear existing primitives, generate apm.yml from inline deps only.
    //    Directory was already created above (actionOwnsDir = true for isolated mode).
    if (isolated) {
      if (!depsInput) {
        throw new Error('isolated mode requires dependencies input');
      }

      // Clean existing primitives so only inline deps remain
      clearPrimitives(resolvedDir);

      const deps = parseDependencies(depsInput);
      await generateManifest(resolvedDir, deps);
      await runApm(['install'], resolvedDir);
    } else {
      // Default: install from apm.yml (if present), then add inline deps
      const apmYmlPath = path.join(resolvedDir, 'apm.yml');
      if (fs.existsSync(apmYmlPath) || !depsInput) {
        await runApm(['install'], resolvedDir);
      }

      // Install extra inline deps additively
      if (depsInput) {
        const deps = parseDependencies(depsInput);
        await installDeps(resolvedDir, deps);
      }
    }

    // Run content audit if report requested
    if (auditReportPath) {
      await runAuditReport(resolvedDir, auditReportPath);
    }

    // 5. Run apm compile (opt-in)
    const compile = core.getInput('compile') === 'true';
    if (compile) {
      core.info('Compiling agent primitives...');
      await runApm(['compile'], resolvedDir);
    }

    // 6. Verify deployment
    const primitivesPath = path.join(resolvedDir, '.github');
    core.info(`Primitives deployed to: ${primitivesPath}`);
    core.setOutput('primitives-path', primitivesPath);
    await listDeployed(primitivesPath);

    // 7. Optionally run a script
    const script = core.getInput('script').trim();
    if (script) {
      core.info(`Running APM script: ${script}`);
      await runApm(['run', script], resolvedDir);
    }

    // 8. Pack mode: produce bundle after install
    if (packInput) {
      const target = core.getInput('target').trim() || undefined;
      const archive = core.getInput('archive') !== 'false';
      const bundlePath = await runPackStep(resolvedDir, { target, archive });
      core.setOutput('bundle-path', bundlePath);
    }

    core.setOutput('success', 'true');
    core.info('APM action completed successfully');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    core.setOutput('success', 'false');
    core.setFailed(`APM action failed: ${msg}`);
  }
}

/**
 * Run `apm audit` to generate a SARIF report.
 * Non-zero exit codes are informational (1=critical, 2=warning) and do not fail the action.
 */
async function runAuditReport(cwd: string, reportPath: string): Promise<void> {
  // Check if apm is available (may not be in restore mode)
  const apmAvailable = await exec.exec('apm', ['--version'], {
    ignoreReturnCode: true,
    silent: true,
  }).catch(() => 1) === 0;

  if (!apmAvailable) {
    core.warning(
      'APM not installed — cannot generate audit report. '
      + 'Install APM for hidden-character audit coverage.',
    );
    return;
  }

  core.info('Running content audit...');
  const auditRc = await exec.exec('apm', [
    'audit', '-f', 'sarif', '-o', reportPath,
  ], {
    cwd,
    ignoreReturnCode: true,
    env: { ...process.env as Record<string, string> },
  });

  if (fs.existsSync(reportPath)) {
    core.setOutput('audit-report-path', reportPath);
    core.info(`Audit report generated: ${reportPath}`);
  }

  if (auditRc === 1) {
    core.warning('APM audit found critical hidden-character findings — see SARIF report for details');
  } else if (auditRc === 2) {
    core.info('APM audit found warnings (non-critical) — see SARIF report for details');
  }

  // Write markdown summary to $GITHUB_STEP_SUMMARY
  try {
    const mdResult = await exec.getExecOutput('apm', [
      'audit', '-f', 'markdown',
    ], {
      cwd,
      ignoreReturnCode: true,
      silent: true,
    });

    if (mdResult.stdout.trim()) {
      await core.summary
        .addRaw('<details><summary>APM Audit Report</summary>\n\n')
        .addRaw(mdResult.stdout)
        .addRaw('\n</details>')
        .write();
    }
  } catch {
    // Markdown summary is best-effort — don't fail the action
    core.debug('Could not generate markdown audit summary');
  }
}

interface ObjectDep {
  git: string;
  path?: string;
  ref?: string;
  alias?: string;
}

type Dependency = string | ObjectDep;

/**
 * Parse the dependencies YAML input into typed dependency entries.
 */
function parseDependencies(input: string): Dependency[] {
  let parsed: unknown;
  try {
    parsed = yaml.load(input);
  } catch (e) {
    throw new Error(`Failed to parse dependencies YAML: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!Array.isArray(parsed)) {
    // Single string value
    if (typeof parsed === 'string') {
      return [parsed];
    }
    throw new Error('dependencies input must be a YAML array (e.g. "- owner/repo")');
  }

  const deps: Dependency[] = [];
  for (const item of parsed) {
    if (typeof item === 'string') {
      deps.push(item);
    } else if (typeof item === 'object' && item !== null && 'git' in item) {
      deps.push(item as ObjectDep);
    } else {
      throw new Error(`Invalid dependency entry: ${JSON.stringify(item)}. Expected string or {git: url, ...}`);
    }
  }

  return deps;
}

/**
 * Install dependencies additively via `apm install <dep>`.
 */
async function installDeps(dir: string, deps: Dependency[]): Promise<void> {
  core.info(`Installing ${deps.length} inline dependencies...`);
  for (const dep of deps) {
    if (typeof dep === 'string') {
      await runApm(['install', dep], dir);
    } else {
      // Object-form: build the install argument
      let installArg = dep.git;
      if (dep.path) {
        installArg += `#path=${dep.path}`;
      }
      if (dep.ref) {
        installArg += (installArg.includes('#') ? '&' : '#') + `ref=${dep.ref}`;
      }
      await runApm(['install', installArg], dir);
    }
  }
}

const PRIMITIVE_DIRS = ['instructions', 'agents', 'skills', 'prompts'] as const;

/**
 * Remove existing primitive directories so isolated mode starts from a clean slate.
 *
 * Security: each computed sub-path is validated to stay within the resolved
 * working directory, preventing path-traversal regardless of where the
 * directory lives on the filesystem.
 */
export function clearPrimitives(dir: string): void {
  const resolved = path.resolve(dir);
  const ghDir = path.join(resolved, '.github');

  // Nothing to clear — empty directory already satisfies isolated mode
  if (!fs.existsSync(ghDir)) {
    core.info('No .github/ directory found — nothing to clear');
    return;
  }

  for (const sub of PRIMITIVE_DIRS) {
    const subPath = path.join(resolved, '.github', sub);
    // Guard: ensure computed path stays within the working directory
    const rel = path.relative(resolved, path.resolve(subPath));
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(
        `clearPrimitives: path traversal detected — "${subPath}" escapes working directory "${resolved}"`,
      );
    }
    if (fs.existsSync(subPath)) {
      fs.rmSync(subPath, { recursive: true });
      core.info(`Cleared .github/${sub}/`);
    }
  }
}

/**
 * Generate a fresh apm.yml from inline dependencies (used with isolated mode).
 */
function generateManifest(dir: string, deps: Dependency[]): void {
  const apmYmlPath = path.join(dir, 'apm.yml');

  const depEntries = deps.map(dep => {
    if (typeof dep === 'string') {
      return `    - ${dep}`;
    }
    // Object-form YAML
    let entry = `    - git: ${dep.git}`;
    if (dep.path) entry += `\n      path: ${dep.path}`;
    if (dep.ref) entry += `\n      ref: ${dep.ref}`;
    if (dep.alias) entry += `\n      alias: ${dep.alias}`;
    return entry;
  });

  const content = `name: inline-workflow\nversion: 1.0.0\ndependencies:\n  apm:\n${depEntries.join('\n')}\n`;
  fs.writeFileSync(apmYmlPath, content, 'utf-8');
  core.info(`Generated apm.yml with ${deps.length} dependencies (isolated mode)`);
}

/**
 * Run an apm command in the given directory.
 */
async function runApm(args: string[], cwd: string): Promise<void> {
  const rc = await exec.exec('apm', args, {
    cwd,
    ignoreReturnCode: true,
    env: { ...process.env as Record<string, string> },
  });
  if (rc !== 0) {
    throw new Error(`apm ${args.join(' ')} failed with exit code ${rc}`);
  }
}

/**
 * List deployed primitives for visibility.
 * Outputs a compact summary line first (survives GH AW 500-char truncation),
 * then per-file details.
 */
async function listDeployed(primitivesPath: string): Promise<void> {
  if (!fs.existsSync(primitivesPath)) {
    core.info('No .github directory found after install — no primitives deployed');
    return;
  }

  const subdirs = ['instructions', 'skills', 'agents', 'prompts'] as const;
  const counts: Record<string, string[]> = {};
  let total = 0;

  for (const sub of subdirs) {
    const subPath = path.join(primitivesPath, sub);
    if (fs.existsSync(subPath)) {
      const files = fs.readdirSync(subPath).filter(f => !f.startsWith('.'));
      if (files.length > 0) {
        counts[sub] = files;
        total += files.length;
      }
    }
  }

  const hasAgentsMd = fs.existsSync(path.join(primitivesPath, '..', 'AGENTS.md'));

  if (total === 0) {
    if (hasAgentsMd) {
      core.info('APM: no primitives deployed (AGENTS.md present)');
    } else {
      core.info('APM: no primitives deployed');
    }
    return;
  }

  // Compact summary line — MUST come first so it survives truncation
  const breakdown = Object.entries(counts)
    .map(([type, files]) => `${files.length} ${type}`)
    .join(', ');
  core.info(`APM: ${total} primitives deployed (${breakdown})${hasAgentsMd ? ' + AGENTS.md' : ''}`);

  // Per-file details (may get truncated — that's OK, headline has the key info)
  for (const [sub, files] of Object.entries(counts)) {
    core.info(`  ${sub}/: ${files.join(', ')}`);
  }
}
