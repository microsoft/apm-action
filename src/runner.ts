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
    // 0. Resolve working directory (needed by all modes)
    const workingDir = core.getInput('working-directory') || '.';
    const resolvedDir = path.resolve(workingDir);
    core.info(`Working directory: ${resolvedDir}`);

    // 0b. Read mode inputs
    const bundleInput = core.getInput('bundle').trim();
    const packInput = core.getInput('pack') === 'true';

    if (bundleInput && packInput) {
      throw new Error("'pack' and 'bundle' inputs are mutually exclusive");
    }

    // RESTORE MODE: extract bundle, skip APM installation entirely
    if (bundleInput) {
      const bundlePath = await resolveLocalBundle(bundleInput, resolvedDir);
      core.info(`Restoring bundle: ${bundlePath}`);
      const result = await extractBundle(bundlePath, resolvedDir);
      const verifiedMsg = result.verified ? ' (verified)' : ' (unverified — install APM for integrity checks)';
      core.info(`Restored ${result.files} file(s)${verifiedMsg}`);

      const primitivesPath = path.join(resolvedDir, '.github');
      core.setOutput('primitives-path', primitivesPath);
      core.setOutput('success', 'true');
      core.info('APM action completed successfully (restore mode)');
      return;
    }

    // 1. Install APM CLI (install + pack modes)
    await ensureApmInstalled();

    // 2. Parse inputs
    const depsInput = core.getInput('dependencies').trim();
    const isolated = core.getInput('isolated') === 'true';

    // 4. Handle isolated mode: clear existing primitives, generate apm.yml from inline deps only
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
