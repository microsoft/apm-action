import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockInfo = jest.fn();
const mockWarning = jest.fn();
const mockSetOutput = jest.fn();
const mockSetSecret = jest.fn();
const mockSummary = {
  addRaw: jest.fn().mockReturnThis(),
  write: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
};

jest.unstable_mockModule('@actions/core', () => ({
  info: mockInfo,
  warning: mockWarning,
  setOutput: mockSetOutput,
  setSecret: mockSetSecret,
  summary: mockSummary,
}));

interface ExecListeners {
  stdout?: (data: Buffer) => void;
  stderr?: (data: Buffer) => void;
}
interface ExecOpts {
  cwd?: string;
  ignoreReturnCode?: boolean;
  silent?: boolean;
  listeners?: ExecListeners;
}
const mockExec = jest.fn<(cmd: string, args?: string[], opts?: ExecOpts) => Promise<number>>();
jest.unstable_mockModule('@actions/exec', () => ({
  exec: mockExec,
}));

const {
  resolveReleaseTag,
  sanitizeTagForPath,
  detectShape,
  discoverPackages,
  resolvePrerelease,
  writeSha256Sidecar,
  stageMarketplaceJson,
  runGate,
  packPackage,
  runReleaseMode,
} = await import('../release.js');

describe('resolveReleaseTag', () => {
  it('prefers explicit input over env', () => {
    expect(resolveReleaseTag('v9.9.9', 'v0.0.1')).toBe('v9.9.9');
  });
  it('falls back to GITHUB_REF_NAME', () => {
    expect(resolveReleaseTag('  ', 'v1.2.3')).toBe('v1.2.3');
  });
  it('throws when both empty', () => {
    expect(() => resolveReleaseTag('', undefined)).toThrow(/release-tag/);
  });
});

describe('sanitizeTagForPath', () => {
  it('passes safe tags through unchanged', () => {
    expect(sanitizeTagForPath('v1.2.3')).toBe('v1.2.3');
    expect(sanitizeTagForPath('1.0.0-rc.1')).toBe('1.0.0-rc.1');
    expect(sanitizeTagForPath('my-pkg_v2')).toBe('my-pkg_v2');
  });
  it('replaces path separators with dashes (path traversal defense)', () => {
    expect(sanitizeTagForPath('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeTagForPath('release/v1')).toBe('release-v1');
    expect(sanitizeTagForPath('v1/../v2')).toBe('v1-v2');
  });
  it('strips leading dots so result cannot be ".." or ".hidden"', () => {
    expect(sanitizeTagForPath('..')).toBe('unversioned');
    expect(sanitizeTagForPath('.hidden')).toBe('hidden');
    expect(sanitizeTagForPath('...v1')).toBe('v1');
  });
  it('strips control characters and other delimiters', () => {
    expect(sanitizeTagForPath('v1\u0000.0')).toBe('v1-0');
    expect(sanitizeTagForPath('v1\n2')).toBe('v1-2');
    expect(sanitizeTagForPath('v1\\..\\v2')).toBe('v1-v2');
  });
  it('returns "unversioned" for empty or pathological input', () => {
    expect(sanitizeTagForPath('')).toBe('unversioned');
    expect(sanitizeTagForPath('///')).toBe('unversioned');
    expect(sanitizeTagForPath('---')).toBe('unversioned');
  });
});

describe('resolvePrerelease', () => {
  it('explicit true wins', () => {
    expect(resolvePrerelease('true', 'v1.0.0')).toBe(true);
  });
  it('explicit false wins', () => {
    expect(resolvePrerelease('false', 'v1.0.0-rc.1')).toBe(false);
  });
  it('auto: hyphen => prerelease', () => {
    expect(resolvePrerelease('auto', 'v1.0.0-rc.1')).toBe(true);
    expect(resolvePrerelease('auto', '1.0.0-beta')).toBe(true);
  });
  it('auto: no hyphen => stable', () => {
    expect(resolvePrerelease('auto', 'v1.0.0')).toBe(false);
    expect(resolvePrerelease('auto', '0.13.0')).toBe(false);
  });
  it('auto: non-semver tag => false (cannot infer)', () => {
    expect(resolvePrerelease('auto', 'release-2024')).toBe(false);
  });
});

describe('detectShape', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-shape-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no plugins dir => single-plugin', () => {
    expect(detectShape(tmpDir)).toBe('single-plugin');
  });
  it('plugins dir but no apm.yml inside => single-plugin', () => {
    fs.mkdirSync(path.join(tmpDir, 'plugins', 'empty'), { recursive: true });
    expect(detectShape(tmpDir)).toBe('single-plugin');
  });
  it('plugins/<name>/apm.yml => aggregator', () => {
    const dir = path.join(tmpDir, 'plugins', 'one');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'apm.yml'), 'name: one\nversion: 0.1.0\n');
    expect(detectShape(tmpDir)).toBe('aggregator');
  });
});

describe('discoverPackages', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-disc-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('single-plugin returns top-level package', () => {
    fs.writeFileSync(path.join(tmpDir, 'apm.yml'), 'name: solo\nversion: 1.0.0\n');
    const pkgs = discoverPackages(tmpDir, 'single-plugin');
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0].name).toBe('solo');
    expect(pkgs[0].version).toBe('1.0.0');
    expect(pkgs[0].dir).toBe(tmpDir);
  });

  it('aggregator iterates plugins/* sorted', () => {
    for (const name of ['beta', 'alpha']) {
      const dir = path.join(tmpDir, 'plugins', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'apm.yml'), `name: ${name}\nversion: 0.1.0\n`);
    }
    const pkgs = discoverPackages(tmpDir, 'aggregator');
    expect(pkgs.map(p => p.name)).toEqual(['alpha', 'beta']);
  });

  it('aggregator with no packages throws', () => {
    fs.mkdirSync(path.join(tmpDir, 'plugins'), { recursive: true });
    expect(() => discoverPackages(tmpDir, 'aggregator')).toThrow(/No packages found/);
  });

  it('apm.yml missing name throws', () => {
    fs.writeFileSync(path.join(tmpDir, 'apm.yml'), 'version: 1.0.0\n');
    expect(() => discoverPackages(tmpDir, 'single-plugin')).toThrow(/missing 'name'/);
  });

  it('apm.yml missing version throws', () => {
    fs.writeFileSync(path.join(tmpDir, 'apm.yml'), 'name: x\n');
    expect(() => discoverPackages(tmpDir, 'single-plugin')).toThrow(/missing 'version'/);
  });
});

describe('writeSha256Sidecar', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-sha-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits sha256sum-compatible sidecar', () => {
    const file = path.join(tmpDir, 'bundle.tar.gz');
    fs.writeFileSync(file, 'hello');
    const { hex, sidecar } = writeSha256Sidecar(file);
    expect(hex).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(sidecar).toBe(file + '.sha256');
    const content = fs.readFileSync(sidecar, 'utf8');
    expect(content).toBe(`${hex}  bundle.tar.gz\n`);
  });
});

describe('stageMarketplaceJson', () => {
  let tmpDir: string;
  let distDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-stage-'));
    distDir = path.join(tmpDir, 'dist');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no marketplace file exists', () => {
    expect(stageMarketplaceJson(tmpDir, distDir, '1.0.0')).toBeNull();
  });

  it('copies .claude-plugin/marketplace.json with version suffix', () => {
    const src = path.join(tmpDir, '.claude-plugin', 'marketplace.json');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, '{"plugins": []}');
    const result = stageMarketplaceJson(tmpDir, distDir, '1.2.3');
    expect(result).toBe(path.join(distDir, 'marketplace-1.2.3.json'));
    expect(fs.readFileSync(result!, 'utf8')).toBe('{"plugins": []}');
  });

  it('falls back to top-level marketplace.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'marketplace.json'), '{}');
    const result = stageMarketplaceJson(tmpDir, distDir, '0.1.0');
    expect(result).toBe(path.join(distDir, 'marketplace-0.1.0.json'));
  });
});

describe('runGate', () => {
  let tmpDir: string;
  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes on exit 0 and returns parsed envelope', async () => {
    mockExec.mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from('{"drift":{"drifted":false}}'));
      return 0;
    });
    const result = await runGate(tmpDir);
    expect(result.drift).toBe(false);
    expect(result.envelope).toEqual({ drift: { drifted: false } });
  });

  it('throws on exit 3 (version misalignment)', async () => {
    mockExec.mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from('{"version_alignment":{"aligned":false}}'));
      return 3;
    });
    await expect(runGate(tmpDir)).rejects.toThrow(/misaligned versions/);
  });

  it('throws on exit 4 (drift) and sets marketplace-drift output', async () => {
    mockExec.mockImplementationOnce(async () => 4);
    await expect(runGate(tmpDir)).rejects.toThrow(/marketplace drift/);
    expect(mockSetOutput).toHaveBeenCalledWith('marketplace-drift', 'true');
  });

  it('throws generic error on other non-zero exits', async () => {
    mockExec.mockImplementationOnce(async () => 1);
    await expect(runGate(tmpDir)).rejects.toThrow(/exit code 1/);
  });
});

describe('packPackage', () => {
  let tmpDir: string;
  let distDir: string;
  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-pack-'));
    distDir = path.join(tmpDir, 'dist');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('invokes apm pack and returns the new tarball', async () => {
    mockExec.mockImplementationOnce(async (_cmd, args) => {
      expect(args).toEqual(['pack', '--offline', '--archive', '-o', distDir]);
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, 'mypkg-1.0.0.tar.gz'), 'fake');
      return 0;
    });
    const tarball = await packPackage(tmpDir, distDir);
    expect(tarball).toBe(path.join(distDir, 'mypkg-1.0.0.tar.gz'));
  });

  it('throws when apm pack fails', async () => {
    mockExec.mockImplementationOnce(async () => 1);
    await expect(packPackage(tmpDir, distDir)).rejects.toThrow(/exit 1/);
  });

  it('throws when no tarball produced', async () => {
    mockExec.mockImplementationOnce(async () => 0);
    await expect(packPackage(tmpDir, distDir)).rejects.toThrow(/produced no \.tar\.gz/);
  });

  it('returns the tarball even when apm pack overwrites an existing file of the same name (regression)', async () => {
    // Simulate a re-run where distDir already contains last invocation's
    // output. Old before/after-diff logic would see fresh=[] and throw
    // despite pack succeeding. mtime-based selection must accept the
    // overwritten file.
    fs.mkdirSync(distDir, { recursive: true });
    const tarballPath = path.join(distDir, 'mypkg-1.0.0.tar.gz');
    fs.writeFileSync(tarballPath, 'stale');
    // Backdate the existing file so the overwrite produces a newer mtime.
    const oldMtime = new Date(Date.now() - 60_000);
    fs.utimesSync(tarballPath, oldMtime, oldMtime);

    mockExec.mockImplementationOnce(async () => {
      fs.writeFileSync(tarballPath, 'fresh');
      return 0;
    });
    const result = await packPackage(tmpDir, distDir);
    expect(result).toBe(tarballPath);
    expect(fs.readFileSync(tarballPath, 'utf8')).toBe('fresh');
  });
});

describe('runReleaseMode (integration, mocked exec)', () => {
  let tmpDir: string;
  let workspace: string;
  let prevWorkspace: string | undefined;
  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-mode-'));
    workspace = tmpDir;
    prevWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = workspace;
  });
  afterEach(() => {
    if (prevWorkspace === undefined) {
      delete process.env.GITHUB_WORKSPACE;
    } else {
      process.env.GITHUB_WORKSPACE = prevWorkspace;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('aggregator happy path: gates, packs each plugin, stages marketplace, skip-publish skips gh', async () => {
    fs.writeFileSync(path.join(tmpDir, 'apm.yml'), 'name: agg\nversion: 1.0.0\n');
    for (const name of ['alpha', 'beta']) {
      const dir = path.join(tmpDir, 'plugins', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'apm.yml'), `name: ${name}\nversion: 0.1.0\n`);
    }
    fs.mkdirSync(path.join(tmpDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.claude-plugin', 'marketplace.json'),
      '{"plugins": [{"name": "alpha"}, {"name": "beta"}]}',
    );

    const distDir = path.join(workspace, 'dist');

    // Gate
    mockExec.mockImplementationOnce(async (cmd, args, opts) => {
      expect(cmd).toBe('apm');
      expect(args?.[0]).toBe('pack');
      expect(args).toContain('--check-versions');
      expect(args).toContain('--check-clean');
      opts?.listeners?.stdout?.(Buffer.from('{"drift":{"drifted":false}}'));
      return 0;
    });
    // Pack alpha
    mockExec.mockImplementationOnce(async (_cmd, _args, opts) => {
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, 'alpha-0.1.0.tar.gz'), 'alpha-bytes');
      expect(opts?.cwd).toBe(path.join(tmpDir, 'plugins', 'alpha'));
      return 0;
    });
    // Pack beta
    mockExec.mockImplementationOnce(async (_cmd, _args, opts) => {
      fs.writeFileSync(path.join(distDir, 'beta-0.1.0.tar.gz'), 'beta-bytes');
      expect(opts?.cwd).toBe(path.join(tmpDir, 'plugins', 'beta'));
      return 0;
    });

    const result = await runReleaseMode({
      workingDir: tmpDir,
      releaseTag: 'v1.0.0',
      releaseName: '',
      releaseNotes: '',
      releaseDraft: false,
      releasePrerelease: 'auto',
      skipPublish: true,
    });

    expect(result.packages).toHaveLength(2);
    expect(result.packages.map(p => p.name).sort()).toEqual(['alpha', 'beta']);
    for (const p of result.packages) {
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.existsSync(p.sha256_path)).toBe(true);
    }
    expect(result.marketplaceDrift).toBe(false);
    expect(result.releaseUrl).toBe('');
    expect(result.releaseTag).toBe('v1.0.0');
    expect(fs.existsSync(path.join(distDir, 'marketplace-1.0.0.json'))).toBe(true);
    // gh release create NOT called (skip-publish)
    expect(mockExec).toHaveBeenCalledTimes(3);
  });

  it('single-plugin happy path: one pack, no marketplace', async () => {
    fs.writeFileSync(path.join(tmpDir, 'apm.yml'), 'name: solo\nversion: 2.0.0\n');
    const distDir = path.join(workspace, 'dist');

    mockExec.mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from('{}'));
      return 0;
    });
    mockExec.mockImplementationOnce(async () => {
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, 'solo-2.0.0.tar.gz'), 'solo');
      return 0;
    });

    const result = await runReleaseMode({
      workingDir: tmpDir,
      releaseTag: 'v2.0.0',
      releaseName: '',
      releaseNotes: '',
      releaseDraft: false,
      releasePrerelease: 'auto',
      skipPublish: true,
    });

    expect(result.packages).toHaveLength(1);
    expect(result.packages[0].name).toBe('solo');
    expect(fs.existsSync(path.join(distDir, 'marketplace-2.0.0.json'))).toBe(false);
  });

  it('calls gh release create when skipPublish=false', async () => {
    fs.writeFileSync(path.join(tmpDir, 'apm.yml'), 'name: solo\nversion: 1.0.0\n');
    const distDir = path.join(workspace, 'dist');

    mockExec.mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from('{}'));
      return 0;
    });
    mockExec.mockImplementationOnce(async () => {
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, 'solo-1.0.0.tar.gz'), 'solo');
      return 0;
    });
    // gh release create
    mockExec.mockImplementationOnce(async (cmd, args, opts) => {
      expect(cmd).toBe('gh');
      expect(args?.slice(0, 3)).toEqual(['release', 'create', 'v1.0.0']);
      expect(args).toContain('--notes-file');
      expect(args).toContain('--title');
      // Should include the tarball + its sha256 sidecar
      expect(args?.some(a => a.endsWith('solo-1.0.0.tar.gz'))).toBe(true);
      expect(args?.some(a => a.endsWith('.sha256'))).toBe(true);
      opts?.listeners?.stdout?.(Buffer.from('https://github.com/o/r/releases/tag/v1.0.0\n'));
      return 0;
    });

    const result = await runReleaseMode({
      workingDir: tmpDir,
      releaseTag: 'v1.0.0',
      releaseName: '',
      releaseNotes: '',
      releaseDraft: false,
      releasePrerelease: 'auto',
      skipPublish: false,
    });
    expect(result.releaseUrl).toBe('https://github.com/o/r/releases/tag/v1.0.0');
  });

  it('passes --draft and --prerelease flags through to gh', async () => {
    fs.writeFileSync(path.join(tmpDir, 'apm.yml'), 'name: solo\nversion: 1.0.0\n');
    const distDir = path.join(workspace, 'dist');

    mockExec.mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from('{}'));
      return 0;
    });
    mockExec.mockImplementationOnce(async () => {
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, 'solo-1.0.0-rc.1.tar.gz'), 'solo');
      return 0;
    });
    mockExec.mockImplementationOnce(async (_cmd, args, opts) => {
      expect(args).toContain('--draft');
      expect(args).toContain('--prerelease');
      opts?.listeners?.stdout?.(Buffer.from('url\n'));
      return 0;
    });

    await runReleaseMode({
      workingDir: tmpDir,
      releaseTag: 'v1.0.0-rc.1',
      releaseName: 'RC1',
      releaseNotes: '',
      releaseDraft: true,
      releasePrerelease: 'auto',
      skipPublish: false,
    });
  });

  it('drift on gate (exit 4) surfaces marketplace-drift=true and fails', async () => {
    fs.writeFileSync(path.join(tmpDir, 'apm.yml'), 'name: solo\nversion: 1.0.0\n');
    mockExec.mockImplementationOnce(async () => 4);
    await expect(runReleaseMode({
      workingDir: tmpDir,
      releaseTag: 'v1.0.0',
      releaseName: '',
      releaseNotes: '',
      releaseDraft: false,
      releasePrerelease: 'auto',
      skipPublish: true,
    })).rejects.toThrow(/marketplace drift/);
    expect(mockSetOutput).toHaveBeenCalledWith('marketplace-drift', 'true');
  });
});
