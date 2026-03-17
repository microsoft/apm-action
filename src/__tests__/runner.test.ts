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

jest.unstable_mockModule('../bundler.js', () => ({
  resolveLocalBundle: jest.fn(),
  extractBundle: jest.fn(),
  runPackStep: jest.fn(),
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
});
