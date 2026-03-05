import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ensureApmInstalled } from './installer';

/**
 * Run the APM action: install + compile agent primitives.
 *
 * Default behavior (no inputs): reads apm.yml, installs deps, compiles AGENTS.md. Done.
 * With `dependencies` input: generates a temporary apm.yml from the inline list.
 * With `isolated: true`: installs to /tmp/apm-isolated instead of repo .github/.
 * With `script` input: runs an apm script after install+compile.
 */
export async function run(): Promise<void> {
  try {
    // 1. Install APM CLI
    await ensureApmInstalled();

    // 2. Resolve working directory
    const workingDir = core.getInput('working-directory') || '.';
    const resolvedDir = path.resolve(workingDir);
    core.info(`Working directory: ${resolvedDir}`);

    // 3. Handle inline dependencies (Phase 2)
    const inlineDeps = core.getInput('dependencies').trim();
    if (inlineDeps) {
      await setupInlineDeps(resolvedDir, inlineDeps);
    }

    // 4. Handle isolation mode (Phase 2)
    const isolated = core.getInput('isolated') === 'true';
    let effectiveDir = resolvedDir;
    if (isolated) {
      effectiveDir = setupIsolatedWorkspace(resolvedDir);
      core.info(`Isolated mode: primitives will be installed to ${effectiveDir}`);
    }

    // 5. Run apm install
    core.info('Installing APM dependencies...');
    await runApm(['install'], effectiveDir);

    // 6. Run apm compile (unless skipped)
    const skipCompile = core.getInput('skip-compile') === 'true';
    if (!skipCompile) {
      core.info('Compiling agent primitives...');
      await runApm(['compile'], effectiveDir);
    }

    // 7. Verify deployment
    const primitivesPath = isolated
      ? path.join(effectiveDir, '.github')
      : path.join(resolvedDir, '.github');
    core.info(`Primitives deployed to: ${primitivesPath}`);
    core.setOutput('primitives-path', primitivesPath);

    // List what was deployed
    await listDeployed(primitivesPath);

    // 8. Optionally run a script
    const script = core.getInput('script').trim();
    if (script) {
      core.info(`Running APM script: ${script}`);
      await runApm(['run', script], effectiveDir);
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
 * Generate a temporary apm.yml from inline dependencies.
 */
async function setupInlineDeps(dir: string, depsBlock: string): Promise<void> {
  const deps = depsBlock
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  if (deps.length === 0) {
    core.warning('dependencies input provided but no valid entries found');
    return;
  }

  const apmYmlPath = path.join(dir, 'apm.yml');

  // Don't overwrite existing apm.yml
  if (fs.existsSync(apmYmlPath)) {
    core.info('apm.yml already exists — inline dependencies will be added via apm install');
    // Use apm install <pkg> to add each one
    for (const dep of deps) {
      await runApm(['install', dep], dir);
    }
    return;
  }

  // Generate apm.yml
  const depLines = deps.map(d => `    - ${d}`).join('\n');
  const content = `name: inline-workflow\nversion: 1.0.0\ndependencies:\n  apm:\n${depLines}\n`;

  fs.writeFileSync(apmYmlPath, content, 'utf-8');
  core.info(`Generated apm.yml with ${deps.length} inline dependencies`);
}

/**
 * Set up an isolated workspace for agent primitives.
 * Copies apm.yml + apm.lock to /tmp/apm-isolated/ so primitives
 * are installed there instead of polluting the repo's .github/.
 */
function setupIsolatedWorkspace(sourceDir: string): string {
  const isolatedDir = path.join(os.tmpdir(), 'apm-isolated');
  fs.mkdirSync(isolatedDir, { recursive: true });

  // Copy manifest files
  for (const file of ['apm.yml', 'apm.lock']) {
    const src = path.join(sourceDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(isolatedDir, file));
    }
  }

  return isolatedDir;
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
 */
async function listDeployed(primitivesPath: string): Promise<void> {
  if (!fs.existsSync(primitivesPath)) {
    core.info('No .github directory found after install — no primitives deployed');
    return;
  }

  const subdirs = ['instructions', 'skills', 'agents', 'prompts'];
  for (const sub of subdirs) {
    const subPath = path.join(primitivesPath, sub);
    if (fs.existsSync(subPath)) {
      const files = fs.readdirSync(subPath);
      if (files.length > 0) {
        core.info(`  ${sub}/: ${files.join(', ')}`);
      }
    }
  }

  // Check for AGENTS.md
  const agentsMd = path.join(primitivesPath, '..', 'AGENTS.md');
  if (fs.existsSync(agentsMd)) {
    core.info('  AGENTS.md compiled');
  }
}
