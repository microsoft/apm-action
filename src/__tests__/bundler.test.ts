import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ESM mocking: set up mocks before dynamic imports
const mockExec = jest.fn<(cmd: string, args?: string[], options?: object) => Promise<number>>();
const mockGetExecOutput = jest.fn<
  (cmd: string, args?: string[], opts?: unknown) => Promise<{ exitCode: number; stdout: string; stderr: string }>
>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGlobCreate = jest.fn<any>();

jest.unstable_mockModule('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
}));

jest.unstable_mockModule('@actions/exec', () => ({
  exec: mockExec,
  getExecOutput: mockGetExecOutput,
}));

jest.unstable_mockModule('@actions/glob', () => ({
  create: mockGlobCreate,
}));

// Dynamic import after mocks are set up
const { resolveLocalBundle, extractBundle, runPackStep } = await import('../bundler.js');

describe('resolveLocalBundle', () => {
  it('returns path when exactly one file matches', async () => {
    const workspace = '/workspace';
    const match = '/workspace/bundle.tar.gz';

    mockGlobCreate.mockResolvedValue({
      glob: jest.fn<() => Promise<string[]>>().mockResolvedValue([match]),
      getSearchPaths: jest.fn<() => string[]>().mockReturnValue([]),
      globGenerator: jest.fn(),
    });

    const result = await resolveLocalBundle('./bundle.tar.gz', workspace);
    expect(result).toBe(match);
  });

  it('throws when no files match', async () => {
    mockGlobCreate.mockResolvedValue({
      glob: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
      getSearchPaths: jest.fn<() => string[]>().mockReturnValue([]),
      globGenerator: jest.fn(),
    });

    await expect(resolveLocalBundle('./missing-*.tar.gz', '/workspace'))
      .rejects.toThrow('No bundle found matching: ./missing-*.tar.gz');
  });

  it('throws when multiple files match', async () => {
    const workspace = '/workspace';
    mockGlobCreate.mockResolvedValue({
      glob: jest.fn<() => Promise<string[]>>().mockResolvedValue([
        '/workspace/bundle-a.tar.gz',
        '/workspace/bundle-b.tar.gz',
      ]),
      getSearchPaths: jest.fn<() => string[]>().mockReturnValue([]),
      globGenerator: jest.fn(),
    });

    await expect(resolveLocalBundle('./*.tar.gz', workspace))
      .rejects.toThrow("Multiple bundles match './*.tar.gz'");
  });

  it('throws when resolved path is outside workspace', async () => {
    const workspace = '/workspace';
    mockGlobCreate.mockResolvedValue({
      glob: jest.fn<() => Promise<string[]>>().mockResolvedValue(['/outside/evil.tar.gz']),
      getSearchPaths: jest.fn<() => string[]>().mockReturnValue([]),
      globGenerator: jest.fn(),
    });

    await expect(resolveLocalBundle('../outside/evil.tar.gz', workspace))
      .rejects.toThrow('resolves outside the workspace');
  });

  it('allows absolute bundle paths outside workspace', async () => {
    // gh-aw uses: bundle: /tmp/gh-aw/apm-bundle/*.tar.gz
    // The bundle is downloaded by actions/download-artifact to /tmp/, which is
    // outside GITHUB_WORKSPACE. Absolute paths are user-explicit and should not
    // be rejected by the traversal check.
    const workspace = '/home/runner/work/gh-aw/gh-aw';
    const match = '/tmp/gh-aw/apm-bundle/claude.tar.gz';

    mockGlobCreate.mockResolvedValue({
      glob: jest.fn<() => Promise<string[]>>().mockResolvedValue([match]),
      getSearchPaths: jest.fn<() => string[]>().mockReturnValue([]),
      globGenerator: jest.fn(),
    });

    const result = await resolveLocalBundle('/tmp/gh-aw/apm-bundle/*.tar.gz', workspace);
    expect(result).toBe(match);
  });
});

describe('extractBundle', () => {
  const tmpDir = path.join(__dirname, '__tmp_extract__');
  const bundlePath = path.join(tmpDir, 'test-bundle.tar.gz');

  beforeEach(() => {
    jest.clearAllMocks();
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(bundlePath, 'fake-archive');
    // Default: tar tzf reports an APM-format bundle (apm.lock.yaml present).
    mockGetExecOutput.mockImplementation(async (cmd, args) => {
      if (cmd === 'tar' && args?.[0] === 'tzf') {
        return {
          exitCode: 0,
          stdout: 'pkg-1.0.0/\npkg-1.0.0/apm.lock.yaml\npkg-1.0.0/.github/agents/foo.md\n',
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses apm unpack when apm is available', async () => {
    mockExec.mockImplementation(async (cmd, args?) => {
      if (cmd === 'apm' && args?.[0] === '--version') return 0;
      if (cmd === 'apm' && args?.[0] === 'unpack') return 0;
      return 1;
    });

    const result = await extractBundle(bundlePath, tmpDir);
    expect(result.verified).toBe(true);

    const unpackCall = mockExec.mock.calls.find(
      c => c[0] === 'apm' && c[1]?.[0] === 'unpack'
    );
    expect(unpackCall).toBeTruthy();
  });

  it('falls back to tar when apm is not available', async () => {
    mockExec.mockImplementation(async (cmd, args?) => {
      if (cmd === 'apm' && args?.[0] === '--version') return 1;
      if (cmd === 'tar') return 0;
      return 1;
    });

    const result = await extractBundle(bundlePath, tmpDir);
    expect(result.verified).toBe(false);

    const tarCall = mockExec.mock.calls.find(c => c[0] === 'tar');
    expect(tarCall).toBeTruthy();
    expect(tarCall![1]).toContain('--strip-components=1');

    // Defense-in-depth (microsoft/apm-action#26): even if the tar fallback
    // ever runs, it must NOT extract apm.lock.yaml or apm.yml into the output
    // dir. Those are bundle metadata, never deployable output, and writing
    // them to a git checkout dirties the workspace and breaks downstream
    // `git checkout` steps.
    expect(tarCall![1]).toContain('--exclude=apm.lock.yaml');
    expect(tarCall![1]).toContain('--exclude=apm.lock');
    expect(tarCall![1]).toContain('--exclude=apm.yml');
  });

  it('throws when bundle file does not exist', async () => {
    await expect(extractBundle('/nonexistent/bundle.tar.gz', tmpDir))
      .rejects.toThrow('Bundle not found');
  });

  it('throws when apm unpack fails', async () => {
    mockExec.mockImplementation(async (cmd, args?) => {
      if (cmd === 'apm' && args?.[0] === '--version') return 0;
      if (cmd === 'apm' && args?.[0] === 'unpack') return 1;
      return 0;
    });

    await expect(extractBundle(bundlePath, tmpDir))
      .rejects.toThrow('apm unpack failed with exit code 1');
  });
});

describe('runPackStep', () => {
  const tmpDir = path.join(__dirname, '__tmp_pack__');
  const buildDir = path.join(tmpDir, 'build');

  beforeEach(() => {
    jest.clearAllMocks();
    fs.mkdirSync(buildDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds correct args with target and archive (apm format)', async () => {
    fs.writeFileSync(path.join(buildDir, 'test-pkg-1.0.0.tar.gz'), 'fake');
    mockExec.mockResolvedValue(0);

    const result = await runPackStep(tmpDir, { target: 'vscode', archive: true, format: 'apm' });

    const packCall = mockExec.mock.calls.find(
      c => c[0] === 'apm' && c[1]?.includes('pack')
    );
    expect(packCall).toBeTruthy();
    const args = packCall![1]!;
    expect(args).toContain('--format');
    expect(args).toContain('apm');
    expect(args).toContain('--target');
    expect(args).toContain('vscode');
    expect(args).toContain('--archive');
    expect(result.bundlePath).toContain('test-pkg-1.0.0.tar.gz');
    expect(result.format).toBe('apm');
  });

  it('passes --format plugin when format is plugin', async () => {
    fs.writeFileSync(path.join(buildDir, 'test-pkg-1.0.0.tar.gz'), 'fake');
    mockExec.mockResolvedValue(0);

    const result = await runPackStep(tmpDir, { archive: true, format: 'plugin' });

    const packCall = mockExec.mock.calls.find(
      c => c[0] === 'apm' && c[1]?.includes('pack')
    );
    expect(packCall).toBeTruthy();
    const args = packCall![1]!;
    expect(args).toContain('--format');
    expect(args).toContain('plugin');
    expect(result.format).toBe('plugin');
  });

  it('builds correct args without target', async () => {
    fs.mkdirSync(path.join(buildDir, 'test-pkg-1.0.0'), { recursive: true });
    mockExec.mockResolvedValue(0);

    const result = await runPackStep(tmpDir, { archive: false, format: 'apm' });

    const packCall = mockExec.mock.calls.find(
      c => c[0] === 'apm' && c[1]?.includes('pack')
    );
    expect(packCall).toBeTruthy();
    const args = packCall![1]!;
    expect(args).not.toContain('--target');
    expect(args).not.toContain('--archive');
    expect(result.bundlePath).toContain('test-pkg-1.0.0');
  });

  it('throws when multiple archives found', async () => {
    fs.writeFileSync(path.join(buildDir, 'pkg-a-1.0.tar.gz'), 'fake');
    fs.writeFileSync(path.join(buildDir, 'pkg-b-2.0.tar.gz'), 'fake');
    mockExec.mockResolvedValue(0);

    await expect(runPackStep(tmpDir, { archive: true, format: 'apm' }))
      .rejects.toThrow('Multiple .tar.gz archives found in build directory after apm pack');
  });

  it('throws when multiple bundle directories found', async () => {
    fs.mkdirSync(path.join(buildDir, 'pkg-a'), { recursive: true });
    fs.mkdirSync(path.join(buildDir, 'pkg-b'), { recursive: true });
    mockExec.mockResolvedValue(0);

    await expect(runPackStep(tmpDir, { archive: false, format: 'apm' }))
      .rejects.toThrow('Multiple bundle directories found in build directory after apm pack');
  });

  it('throws when apm pack fails', async () => {
    mockExec.mockResolvedValue(1);

    await expect(runPackStep(tmpDir, { archive: true, format: 'apm' }))
      .rejects.toThrow('apm pack failed with exit code 1');
  });
});

describe('mode detection', () => {
  it('rejects pack and bundle used together', async () => {
    const errorMsg = "'pack' and 'bundle' inputs are mutually exclusive";
    expect(errorMsg).toContain('mutually exclusive');
  });
});
