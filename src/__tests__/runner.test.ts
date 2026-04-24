import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockInfo = jest.fn();
const mockWarning = jest.fn();
const mockDebug = jest.fn();
const mockGetInput = jest.fn();
const mockSetOutput = jest.fn();
const mockSetFailed = jest.fn();
const mockSetSecret = jest.fn();
const mockSummary = {
  addRaw: jest.fn().mockReturnThis(),
  write: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
};

jest.unstable_mockModule('@actions/core', () => ({
  info: mockInfo,
  warning: mockWarning,
  debug: mockDebug,
  getInput: mockGetInput,
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  setSecret: mockSetSecret,
  summary: mockSummary,
}));

const mockExec = jest.fn<() => Promise<number>>();
const mockGetExecOutput = jest.fn<() => Promise<{ exitCode: number; stdout: string; stderr: string }>>();
jest.unstable_mockModule('@actions/exec', () => ({
  exec: mockExec,
  getExecOutput: mockGetExecOutput,
}));

const mockEnsureApmInstalled = jest.fn<() => Promise<void>>();
jest.unstable_mockModule('../installer.js', () => ({
  ensureApmInstalled: mockEnsureApmInstalled,
}));

const mockResolveLocalBundle = jest.fn<() => Promise<string>>();
const mockExtractBundle = jest.fn<() => Promise<{ files: number; verified: boolean }>>();
const mockRunPackStep = jest.fn<() => Promise<string>>();
jest.unstable_mockModule('../bundler.js', () => ({
  resolveLocalBundle: mockResolveLocalBundle,
  extractBundle: mockExtractBundle,
  runPackStep: mockRunPackStep,
}));

const { clearPrimitives, run } = await import('../runner.js');

describe('clearPrimitives', () => {
  let tmpDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-action-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns early when no .github/ directory exists', () => {
    // tmpDir is empty — no .github/ at all
    clearPrimitives(tmpDir);

    expect(mockInfo).toHaveBeenCalledWith(
      'No .github/ directory found — nothing to clear',
    );
  });

  it('removes existing primitive directories under .github/', () => {
    const ghDir = path.join(tmpDir, '.github');
    fs.mkdirSync(path.join(ghDir, 'instructions'), { recursive: true });
    fs.mkdirSync(path.join(ghDir, 'skills', 'test-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(ghDir, 'instructions', 'test.md'),
      '# test',
    );
    fs.writeFileSync(
      path.join(ghDir, 'skills', 'test-skill', 'SKILL.md'),
      '# skill',
    );

    clearPrimitives(tmpDir);

    expect(fs.existsSync(path.join(ghDir, 'instructions'))).toBe(false);
    expect(fs.existsSync(path.join(ghDir, 'skills'))).toBe(false);
    expect(mockInfo).toHaveBeenCalledWith('Cleared .github/instructions/');
    expect(mockInfo).toHaveBeenCalledWith('Cleared .github/skills/');
  });

  it('leaves non-primitive directories under .github/ intact', () => {
    const ghDir = path.join(tmpDir, '.github');
    fs.mkdirSync(path.join(ghDir, 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(ghDir, 'instructions'), { recursive: true });
    fs.writeFileSync(
      path.join(ghDir, 'workflows', 'ci.yml'),
      'name: CI',
    );

    clearPrimitives(tmpDir);

    // workflows/ should still exist
    expect(fs.existsSync(path.join(ghDir, 'workflows', 'ci.yml'))).toBe(true);
    // instructions/ should be gone
    expect(fs.existsSync(path.join(ghDir, 'instructions'))).toBe(false);
  });

  it('works with directories outside GITHUB_WORKSPACE', () => {
    // This is the exact scenario gh-aw hits: working-directory is /tmp/*
    // while GITHUB_WORKSPACE is /home/runner/work/...
    const prevWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = '/home/runner/work/gh-aw/gh-aw';

    try {
      const ghDir = path.join(tmpDir, '.github');
      fs.mkdirSync(path.join(ghDir, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(ghDir, 'agents', 'test.md'), '# agent');

      // Should NOT throw — the old code threw here
      clearPrimitives(tmpDir);

      expect(fs.existsSync(path.join(ghDir, 'agents'))).toBe(false);
      expect(mockInfo).toHaveBeenCalledWith('Cleared .github/agents/');
    } finally {
      if (prevWorkspace === undefined) {
        delete process.env.GITHUB_WORKSPACE;
      } else {
        process.env.GITHUB_WORKSPACE = prevWorkspace;
      }
    }
  });

  it('does nothing when .github/ exists but has no primitive dirs', () => {
    const ghDir = path.join(tmpDir, '.github');
    fs.mkdirSync(path.join(ghDir, 'workflows'), { recursive: true });

    clearPrimitives(tmpDir);

    // No "Cleared" messages — only primitive dirs are touched
    const clearedCalls = mockInfo.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('Cleared'),
    );
    expect(clearedCalls).toHaveLength(0);
  });
});

describe('run', () => {
  let tmpDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-action-run-'));
    mockEnsureApmInstalled.mockResolvedValue(undefined);
    mockExec.mockResolvedValue(0);
    mockGetExecOutput.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates working directory when it does not exist (isolated mode)', async () => {
    const nonExistentDir = path.join(tmpDir, 'nested', 'workdir');
    expect(fs.existsSync(nonExistentDir)).toBe(false);

    mockGetInput.mockImplementation((name: unknown) => {
      switch (name) {
        case 'working-directory': return nonExistentDir;
        case 'dependencies': return 'microsoft/some-package';
        case 'isolated': return 'true';
        case 'bundle': return '';
        case 'pack': return 'false';
        case 'compile': return 'false';
        case 'script': return '';
        default: return '';
      }
    });

    await run();

    // Directory was created
    expect(fs.existsSync(nonExistentDir)).toBe(true);
    // apm.yml was generated inside it
    expect(fs.existsSync(path.join(nonExistentDir, 'apm.yml'))).toBe(true);
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it('fails fast when working directory does not exist in non-isolated mode', async () => {
    const nonExistentDir = path.join(tmpDir, 'does-not-exist');

    mockGetInput.mockImplementation((name: unknown) => {
      switch (name) {
        case 'working-directory': return nonExistentDir;
        case 'dependencies': return '';
        case 'isolated': return 'false';
        case 'bundle': return '';
        case 'pack': return 'false';
        case 'compile': return 'false';
        case 'script': return '';
        default: return '';
      }
    });

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('Working directory does not exist'),
    );
    // Directory should NOT have been created
    expect(fs.existsSync(nonExistentDir)).toBe(false);
  });

  it('resolves audit-report "true" to default sarif path', async () => {
    // Create apm.yml so install path works
    fs.writeFileSync(path.join(tmpDir, 'apm.yml'), 'name: test\nversion: 1.0.0\n');
    fs.mkdirSync(path.join(tmpDir, '.github'), { recursive: true });

    // Simulate: apm install succeeds, apm --version succeeds, apm audit succeeds and creates file
    (mockExec as jest.Mock).mockImplementation(async (...fnArgs: unknown[]) => {
      const _cmd = fnArgs[0] as string;
      const args = fnArgs[1] as string[] | undefined;
      if (_cmd === 'apm' && args?.[0] === 'audit') {
        // Simulate apm audit creating the SARIF file
        const outputIdx = args.indexOf('-o');
        if (outputIdx >= 0 && args[outputIdx + 1]) {
          fs.writeFileSync(args[outputIdx + 1], '{}');
        }
        return 0;
      }
      return 0;
    });

    mockGetInput.mockImplementation((name: unknown) => {
      switch (name) {
        case 'working-directory': return tmpDir;
        case 'dependencies': return '';
        case 'isolated': return 'false';
        case 'bundle': return '';
        case 'pack': return 'false';
        case 'compile': return 'false';
        case 'script': return '';
        case 'audit-report': return 'true';
        default: return '';
      }
    });

    await run();

    expect(mockSetFailed).not.toHaveBeenCalled();
    const expectedPath = path.join(tmpDir, 'apm-audit.sarif');
    expect(mockSetOutput).toHaveBeenCalledWith('audit-report-path', expectedPath);
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Audit report generated'));
  });

  it('resolves audit-report custom path', async () => {
    fs.writeFileSync(path.join(tmpDir, 'apm.yml'), 'name: test\nversion: 1.0.0\n');
    fs.mkdirSync(path.join(tmpDir, '.github'), { recursive: true });

    (mockExec as jest.Mock).mockImplementation(async (...fnArgs: unknown[]) => {
      const _cmd = fnArgs[0] as string;
      const args = fnArgs[1] as string[] | undefined;
      if (_cmd === 'apm' && args?.[0] === 'audit') {
        const outputIdx = args.indexOf('-o');
        if (outputIdx >= 0 && args[outputIdx + 1]) {
          const reportFile = args[outputIdx + 1];
          fs.mkdirSync(path.dirname(reportFile), { recursive: true });
          fs.writeFileSync(reportFile, '{}');
        }
        return 0;
      }
      return 0;
    });

    mockGetInput.mockImplementation((name: unknown) => {
      switch (name) {
        case 'working-directory': return tmpDir;
        case 'dependencies': return '';
        case 'isolated': return 'false';
        case 'bundle': return '';
        case 'pack': return 'false';
        case 'compile': return 'false';
        case 'script': return '';
        case 'audit-report': return 'reports/my-audit.sarif';
        default: return '';
      }
    });

    await run();

    expect(mockSetFailed).not.toHaveBeenCalled();
    const expectedPath = path.resolve(tmpDir, 'reports/my-audit.sarif');
    // Verify audit was called with the custom path
    const auditCall = (mockExec as jest.Mock).mock.calls.find(
      (c: unknown[]) => c[0] === 'apm' && (c[1] as string[])?.[0] === 'audit',
    );
    expect(auditCall).toBeTruthy();
    expect((auditCall![1] as string[])).toContain(expectedPath);
  });

  it('emits warning when audit finds critical findings (exit code 1)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'apm.yml'), 'name: test\nversion: 1.0.0\n');
    fs.mkdirSync(path.join(tmpDir, '.github'), { recursive: true });

    (mockExec as jest.Mock).mockImplementation(async (...fnArgs: unknown[]) => {
      const _cmd = fnArgs[0] as string;
      const args = fnArgs[1] as string[] | undefined;
      if (_cmd === 'apm' && args?.[0] === 'audit') {
        const outputIdx = args.indexOf('-o');
        if (outputIdx >= 0 && args[outputIdx + 1]) {
          fs.writeFileSync(args[outputIdx + 1], '{}');
        }
        return 1; // critical findings
      }
      return 0;
    });

    mockGetInput.mockImplementation((name: unknown) => {
      switch (name) {
        case 'working-directory': return tmpDir;
        case 'dependencies': return '';
        case 'isolated': return 'false';
        case 'bundle': return '';
        case 'pack': return 'false';
        case 'compile': return 'false';
        case 'script': return '';
        case 'audit-report': return 'true';
        default: return '';
      }
    });

    await run();

    expect(mockSetFailed).not.toHaveBeenCalled(); // audit does NOT fail the action
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('critical hidden-character findings'),
    );
  });

  it('does not run audit when audit-report is empty', async () => {
    fs.writeFileSync(path.join(tmpDir, 'apm.yml'), 'name: test\nversion: 1.0.0\n');
    fs.mkdirSync(path.join(tmpDir, '.github'), { recursive: true });
    mockExec.mockResolvedValue(0);

    mockGetInput.mockImplementation((name: unknown) => {
      switch (name) {
        case 'working-directory': return tmpDir;
        case 'dependencies': return '';
        case 'isolated': return 'false';
        case 'bundle': return '';
        case 'pack': return 'false';
        case 'compile': return 'false';
        case 'script': return '';
        case 'audit-report': return '';
        default: return '';
      }
    });

    await run();

    expect(mockSetFailed).not.toHaveBeenCalled();
    const auditCall = (mockExec as jest.Mock).mock.calls.find(
      (c: unknown[]) => c[0] === 'apm' && (c[1] as string[])?.[0] === 'audit',
    );
    expect(auditCall).toBeUndefined();
    expect(mockSetOutput).not.toHaveBeenCalledWith('audit-report-path', expect.anything());
  });

  it('passes github-token input as GITHUB_TOKEN and GITHUB_APM_PAT env vars', async () => {
    fs.writeFileSync(path.join(tmpDir, 'apm.yml'), 'name: test\nversion: 1.0.0\n');
    fs.mkdirSync(path.join(tmpDir, '.github'), { recursive: true });
    mockExec.mockResolvedValue(0);

    const prevToken = process.env.GITHUB_TOKEN;
    const prevApmPat = process.env.GITHUB_APM_PAT;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_APM_PAT;

    try {
      mockGetInput.mockImplementation((name: unknown) => {
        switch (name) {
          case 'working-directory': return tmpDir;
          case 'dependencies': return '';
          case 'isolated': return 'false';
          case 'bundle': return '';
          case 'pack': return 'false';
          case 'compile': return 'false';
          case 'script': return '';
          case 'audit-report': return '';
          case 'github-token': return 'ghs_fakeToken123';
          default: return '';
        }
      });

      await run();

      expect(mockSetFailed).not.toHaveBeenCalled();
      // Token should be set in process.env for subprocess inheritance
      expect(process.env.GITHUB_TOKEN).toBe('ghs_fakeToken123');
      expect(process.env.GITHUB_APM_PAT).toBe('ghs_fakeToken123');
      // Token should be masked in logs
      expect(mockSetSecret).toHaveBeenCalledWith('ghs_fakeToken123');
    } finally {
      if (prevToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = prevToken;
      }
      if (prevApmPat === undefined) {
        delete process.env.GITHUB_APM_PAT;
      } else {
        process.env.GITHUB_APM_PAT = prevApmPat;
      }
    }
  });

  it('does not set GITHUB_TOKEN or GITHUB_APM_PAT when github-token input is empty', async () => {
    fs.writeFileSync(path.join(tmpDir, 'apm.yml'), 'name: test\nversion: 1.0.0\n');
    fs.mkdirSync(path.join(tmpDir, '.github'), { recursive: true });
    mockExec.mockResolvedValue(0);

    const prevToken = process.env.GITHUB_TOKEN;
    const prevApmPat = process.env.GITHUB_APM_PAT;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_APM_PAT;

    try {
      mockGetInput.mockImplementation((name: unknown) => {
        switch (name) {
          case 'working-directory': return tmpDir;
          case 'dependencies': return '';
          case 'isolated': return 'false';
          case 'bundle': return '';
          case 'pack': return 'false';
          case 'compile': return 'false';
          case 'script': return '';
          case 'audit-report': return '';
          case 'github-token': return '';
          default: return '';
        }
      });

      await run();

      expect(mockSetFailed).not.toHaveBeenCalled();
      // Tokens should NOT be set when input is empty
      expect(process.env.GITHUB_TOKEN).toBeUndefined();
      expect(process.env.GITHUB_APM_PAT).toBeUndefined();
      expect(mockSetSecret).not.toHaveBeenCalled();
    } finally {
      if (prevToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = prevToken;
      }
      if (prevApmPat === undefined) {
        delete process.env.GITHUB_APM_PAT;
      } else {
        process.env.GITHUB_APM_PAT = prevApmPat;
      }
    }
  });

  it('does not clobber existing GITHUB_TOKEN from job-level env', async () => {
    fs.writeFileSync(path.join(tmpDir, 'apm.yml'), 'name: test\nversion: 1.0.0\n');
    fs.mkdirSync(path.join(tmpDir, '.github'), { recursive: true });
    mockExec.mockResolvedValue(0);

    const prevToken = process.env.GITHUB_TOKEN;
    const prevApmPat = process.env.GITHUB_APM_PAT;
    process.env.GITHUB_TOKEN = 'ghp_userProvidedPAT';
    delete process.env.GITHUB_APM_PAT;

    try {
      mockGetInput.mockImplementation((name: unknown) => {
        switch (name) {
          case 'working-directory': return tmpDir;
          case 'dependencies': return '';
          case 'isolated': return 'false';
          case 'bundle': return '';
          case 'pack': return 'false';
          case 'compile': return 'false';
          case 'script': return '';
          case 'audit-report': return '';
          case 'github-token': return 'ghs_defaultActionToken';
          default: return '';
        }
      });

      await run();

      expect(mockSetFailed).not.toHaveBeenCalled();
      // User's PAT should be preserved, not overwritten by the action default
      expect(process.env.GITHUB_TOKEN).toBe('ghp_userProvidedPAT');
      // GITHUB_APM_PAT must NOT be set to the default token — doing so would
      // shadow the caller's intentional GITHUB_TOKEN in APM's precedence chain
      expect(process.env.GITHUB_APM_PAT).toBeUndefined();
    } finally {
      if (prevToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = prevToken;
      }
      if (prevApmPat === undefined) {
        delete process.env.GITHUB_APM_PAT;
      } else {
        process.env.GITHUB_APM_PAT = prevApmPat;
      }
    }
  });

  it('does not shadow caller GITHUB_TOKEN with GITHUB_APM_PAT (gh-aw app-token scenario)', async () => {
    // Reproduces the gh-aw bug: gh-aw sets GITHUB_TOKEN to a GitHub App token
    // (cross-org access) via step env:, while the action's github-token input
    // defaults to github.token (scoped to the workflow repo only).
    // Before the fix, GITHUB_APM_PAT was set to the default token, which
    // shadowed the App token in APM's precedence chain.
    fs.writeFileSync(path.join(tmpDir, 'apm.yml'), 'name: test\nversion: 1.0.0\n');
    fs.mkdirSync(path.join(tmpDir, '.github'), { recursive: true });
    mockExec.mockResolvedValue(0);

    const prevToken = process.env.GITHUB_TOKEN;
    const prevApmPat = process.env.GITHUB_APM_PAT;
    // Simulate gh-aw: step env sets GITHUB_TOKEN to the minted App token
    process.env.GITHUB_TOKEN = 'ghs_crossOrgAppToken_abc123';
    delete process.env.GITHUB_APM_PAT;

    try {
      mockGetInput.mockImplementation((name: unknown) => {
        switch (name) {
          case 'working-directory': return tmpDir;
          case 'dependencies': return '- some-org/private-marketplace/plugins/essentials';
          case 'isolated': return 'true';
          case 'bundle': return '';
          case 'pack': return 'true';
          case 'compile': return 'false';
          case 'script': return '';
          case 'audit-report': return '';
          case 'target': return 'copilot';
          case 'archive': return 'true';
          // This is the default github.token — NOT the App token
          case 'github-token': return 'ghs_workflowDefaultToken_xyz789';
          default: return '';
        }
      });

      await run();

      // GITHUB_TOKEN must remain the App token (not overwritten)
      expect(process.env.GITHUB_TOKEN).toBe('ghs_crossOrgAppToken_abc123');
      // GITHUB_APM_PAT must NOT be set — if it were, APM would use it
      // (higher precedence) instead of the correct App token
      expect(process.env.GITHUB_APM_PAT).toBeUndefined();
    } finally {
      if (prevToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = prevToken;
      }
      if (prevApmPat === undefined) {
        delete process.env.GITHUB_APM_PAT;
      } else {
        process.env.GITHUB_APM_PAT = prevApmPat;
      }
    }
  });

  it('does not clobber existing GITHUB_APM_PAT from job-level env', async () => {
    fs.writeFileSync(path.join(tmpDir, 'apm.yml'), 'name: test\nversion: 1.0.0\n');
    fs.mkdirSync(path.join(tmpDir, '.github'), { recursive: true });
    mockExec.mockResolvedValue(0);

    const prevApmPat = process.env.GITHUB_APM_PAT;
    process.env.GITHUB_APM_PAT = 'ghp_userProvidedApmPAT';

    try {
      mockGetInput.mockImplementation((name: unknown) => {
        switch (name) {
          case 'working-directory': return tmpDir;
          case 'dependencies': return '';
          case 'isolated': return 'false';
          case 'bundle': return '';
          case 'pack': return 'false';
          case 'compile': return 'false';
          case 'script': return '';
          case 'audit-report': return '';
          case 'github-token': return 'ghs_defaultActionToken';
          default: return '';
        }
      });

      await run();

      expect(mockSetFailed).not.toHaveBeenCalled();
      // User's explicitly-set GITHUB_APM_PAT should be preserved
      expect(process.env.GITHUB_APM_PAT).toBe('ghp_userProvidedApmPAT');
    } finally {
      if (prevApmPat === undefined) {
        delete process.env.GITHUB_APM_PAT;
      } else {
        process.env.GITHUB_APM_PAT = prevApmPat;
      }
    }
  });

  it('treats empty-string GITHUB_TOKEN as not-provided and forwards token correctly', async () => {
    // Edge case: GITHUB_TOKEN is set to '' (empty string). The ??= operator
    // treats '' as not-nullish, so it wouldn't overwrite it. We must treat
    // empty-string as "not provided" to ensure APM gets a usable token.
    fs.writeFileSync(path.join(tmpDir, 'apm.yml'), 'name: test\nversion: 1.0.0\n');
    fs.mkdirSync(path.join(tmpDir, '.github'), { recursive: true });
    mockExec.mockResolvedValue(0);

    const prevToken = process.env.GITHUB_TOKEN;
    const prevApmPat = process.env.GITHUB_APM_PAT;
    process.env.GITHUB_TOKEN = '';
    delete process.env.GITHUB_APM_PAT;

    try {
      mockGetInput.mockImplementation((name: unknown) => {
        switch (name) {
          case 'working-directory': return tmpDir;
          case 'dependencies': return '';
          case 'isolated': return 'false';
          case 'bundle': return '';
          case 'pack': return 'false';
          case 'compile': return 'false';
          case 'script': return '';
          case 'audit-report': return '';
          case 'github-token': return 'ghs_validToken123';
          default: return '';
        }
      });

      await run();

      expect(mockSetFailed).not.toHaveBeenCalled();
      // Empty GITHUB_TOKEN should be overwritten with the input token
      expect(process.env.GITHUB_TOKEN).toBe('ghs_validToken123');
      // GITHUB_APM_PAT should also be set (no "real" caller token existed)
      expect(process.env.GITHUB_APM_PAT).toBe('ghs_validToken123');
    } finally {
      if (prevToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = prevToken;
      }
      if (prevApmPat === undefined) {
        delete process.env.GITHUB_APM_PAT;
      } else {
        process.env.GITHUB_APM_PAT = prevApmPat;
      }
    }
  });
});

describe('run (restore mode)', () => {
  let tmpDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-action-restore-'));
    mockEnsureApmInstalled.mockResolvedValue(undefined);
    mockExec.mockResolvedValue(0);
    mockGetExecOutput.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockResolveLocalBundle.mockImplementation(async () => path.join(tmpDir, 'bundle.tar.gz'));
    mockExtractBundle.mockResolvedValue({ files: 5, verified: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Regression test for microsoft/apm-action#26.
  // Before the fix, restore mode deliberately skipped ensureApmInstalled() for
  // speed, which forced extractBundle through its raw `tar xzf` fallback and
  // dumped the bundle's apm.lock.yaml / apm.yml into working-directory. That
  // dirtied any git checkout consumers (e.g. gh-aw pull_request_target flows)
  // and broke their subsequent `git checkout` step. Restore mode must always
  // install APM so extractBundle takes the verified `apm unpack` path.
  it('installs APM before extracting (so apm unpack is used, not the tar fallback)', async () => {
    mockGetInput.mockImplementation((name: unknown) => {
      switch (name) {
        case 'working-directory': return tmpDir;
        case 'bundle': return './bundle.tar.gz';
        case 'isolated': return 'false';
        case 'pack': return 'false';
        case 'compile': return 'false';
        case 'script': return '';
        default: return '';
      }
    });

    await run();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockEnsureApmInstalled).toHaveBeenCalledTimes(1);
    expect(mockExtractBundle).toHaveBeenCalledTimes(1);

    // Order matters: install must complete before extract starts so apm unpack
    // is on PATH when extractBundle probes for it.
    const installOrder = mockEnsureApmInstalled.mock.invocationCallOrder[0];
    const extractOrder = mockExtractBundle.mock.invocationCallOrder[0];
    expect(installOrder).toBeLessThan(extractOrder);
  });
});
