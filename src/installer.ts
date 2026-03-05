import * as core from '@actions/core';
import * as exec from '@actions/exec';

const APM_INSTALL_URL = 'https://raw.githubusercontent.com/microsoft/apm/main/install.sh';

/**
 * Ensure APM CLI is installed and available on the runner.
 */
export async function ensureApmInstalled(): Promise<void> {
  const apmVersion = core.getInput('apm-version') || 'latest';

  // Check if already available
  const rc = await exec.exec('apm', ['--version'], { ignoreReturnCode: true, silent: true }).catch(() => 1);
  if (rc === 0) {
    core.info('APM already installed');
    return;
  }

  core.info(`Installing APM (version: ${apmVersion})...`);

  const installEnv: Record<string, string> = { ...process.env as Record<string, string> };
  if (apmVersion !== 'latest') {
    installEnv['APM_VERSION'] = apmVersion;
  }

  await exec.exec('sh', ['-c', `curl -sSL ${APM_INSTALL_URL} | sh`], { env: installEnv });

  // Add to PATH
  const apmBin = `${process.env.HOME}/.apm/bin`;
  core.addPath(apmBin);
  process.env.PATH = `${apmBin}:${process.env.PATH}`;

  // Verify
  const verify = await exec.exec('apm', ['--version'], { ignoreReturnCode: true });
  if (verify !== 0) {
    throw new Error('APM installation verification failed');
  }

  core.info('APM installed successfully');
}
