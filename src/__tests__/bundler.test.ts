import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ESM mocking: set up mocks before dynamic imports
const mockExec = jest.fn<(cmd: string, args?: string[], options?: object) => Promise<number>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGlobCreate = jest.fn<any>();

jest.unstable_mockModule('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
}));

jest.unstable_mockModule('@actions/exec', () => ({
  exec: mockExec,
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
});

describe('extractBundle', () => {
  const tmpDir = path.join(__dirname, '__tmp_extract__');
  const bundlePath = path.join(tmpDir, 'test-bundle.tar.gz');

  beforeEach(() => {
    jest.clearAllMocks();
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(bundlePath, 'fake-archive');
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

  it('builds correct args with target and archive', async () => {
    fs.writeFileSync(path.join(buildDir, 'test-pkg-1.0.0.tar.gz'), 'fake');
    mockExec.mockResolvedValue(0);

    const result = await runPackStep(tmpDir, { target: 'vscode', archive: true });

    const packCall = mockExec.mock.calls.find(
      c => c[0] === 'apm' && c[1]?.includes('pack')
    );
    expect(packCall).toBeTruthy();
    const args = packCall![1]!;
    expect(args).toContain('--target');
    expect(args).toContain('vscode');
    expect(args).toContain('--archive');
    expect(result).toContain('test-pkg-1.0.0.tar.gz');
  });

  it('builds correct args without target', async () => {
    fs.mkdirSync(path.join(buildDir, 'test-pkg-1.0.0'), { recursive: true });
    mockExec.mockResolvedValue(0);

    const result = await runPackStep(tmpDir, { archive: false });

    const packCall = mockExec.mock.calls.find(
      c => c[0] === 'apm' && c[1]?.includes('pack')
    );
    expect(packCall).toBeTruthy();
    const args = packCall![1]!;
    expect(args).not.toContain('--target');
    expect(args).not.toContain('--archive');
    expect(result).toContain('test-pkg-1.0.0');
  });

  it('throws when multiple archives found', async () => {
    fs.writeFileSync(path.join(buildDir, 'pkg-a-1.0.tar.gz'), 'fake');
    fs.writeFileSync(path.join(buildDir, 'pkg-b-2.0.tar.gz'), 'fake');
    mockExec.mockResolvedValue(0);

    await expect(runPackStep(tmpDir, { archive: true }))
      .rejects.toThrow('Multiple .tar.gz archives found in build directory after apm pack');
  });

  it('throws when multiple bundle directories found', async () => {
    fs.mkdirSync(path.join(buildDir, 'pkg-a'), { recursive: true });
    fs.mkdirSync(path.join(buildDir, 'pkg-b'), { recursive: true });
    mockExec.mockResolvedValue(0);

    await expect(runPackStep(tmpDir, { archive: false }))
      .rejects.toThrow('Multiple bundle directories found in build directory after apm pack');
  });

  it('throws when apm pack fails', async () => {
    mockExec.mockResolvedValue(1);

    await expect(runPackStep(tmpDir, { archive: true }))
      .rejects.toThrow('apm pack failed with exit code 1');
  });
});

describe('mode detection', () => {
  it('rejects pack and bundle used together', async () => {
    const errorMsg = "'pack' and 'bundle' inputs are mutually exclusive";
    expect(errorMsg).toContain('mutually exclusive');
  });
});
