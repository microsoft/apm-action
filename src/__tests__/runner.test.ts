import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockInfo = jest.fn();

jest.unstable_mockModule('@actions/core', () => ({
  info: mockInfo,
  warning: jest.fn(),
  getInput: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
}));

const { clearPrimitives } = await import('../runner.js');

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

    const ghDir = path.join(tmpDir, '.github');
    fs.mkdirSync(path.join(ghDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'agents', 'test.md'), '# agent');

    // Should NOT throw — the old code threw here
    clearPrimitives(tmpDir);

    expect(fs.existsSync(path.join(ghDir, 'agents'))).toBe(false);
    expect(mockInfo).toHaveBeenCalledWith('Cleared .github/agents/');

    // Restore
    if (prevWorkspace === undefined) {
      delete process.env.GITHUB_WORKSPACE;
    } else {
      process.env.GITHUB_WORKSPACE = prevWorkspace;
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
