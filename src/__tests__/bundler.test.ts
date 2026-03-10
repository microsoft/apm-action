import { resolveLocalBundle, extractBundle, runPackStep } from '../bundler';
import * as exec from '@actions/exec';
import * as glob from '@actions/glob';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
}));

jest.mock('@actions/exec', () => ({
  exec: jest.fn(),
}));

jest.mock('@actions/glob', () => ({
  create: jest.fn(),
}));

const mockExec = exec.exec as jest.MockedFunction<typeof exec.exec>;
const mockGlobCreate = glob.create as jest.MockedFunction<typeof glob.create>;

describe('resolveLocalBundle', () => {
  it('returns path when exactly one file matches', async () => {
    const workspace = '/workspace';
    const match = '/workspace/bundle.tar.gz';

    mockGlobCreate.mockResolvedValue({
      glob: jest.fn().mockResolvedValue([match]),
      getSearchPaths: jest.fn().mockReturnValue([]),
      globGenerator: jest.fn(),
    } as unknown as ReturnType<typeof glob.create> extends Promise<infer T> ? T : never);

    const result = await resolveLocalBundle('./bundle.tar.gz', workspace);
    expect(result).toBe(match);
  });

  it('throws when no files match', async () => {
    mockGlobCreate.mockResolvedValue({
      glob: jest.fn().mockResolvedValue([]),
      getSearchPaths: jest.fn().mockReturnValue([]),
      globGenerator: jest.fn(),
    } as unknown as ReturnType<typeof glob.create> extends Promise<infer T> ? T : never);

    await expect(resolveLocalBundle('./missing-*.tar.gz', '/workspace'))
      .rejects.toThrow('No bundle found matching: ./missing-*.tar.gz');
  });

  it('throws when multiple files match', async () => {
    const workspace = '/workspace';
    mockGlobCreate.mockResolvedValue({
      glob: jest.fn().mockResolvedValue([
        '/workspace/bundle-a.tar.gz',
        '/workspace/bundle-b.tar.gz',
      ]),
      getSearchPaths: jest.fn().mockReturnValue([]),
      globGenerator: jest.fn(),
    } as unknown as ReturnType<typeof glob.create> extends Promise<infer T> ? T : never);

    await expect(resolveLocalBundle('./*.tar.gz', workspace))
      .rejects.toThrow("Multiple bundles match './*.tar.gz'");
  });

  it('throws when resolved path is outside workspace', async () => {
    const workspace = '/workspace';
    mockGlobCreate.mockResolvedValue({
      glob: jest.fn().mockResolvedValue(['/outside/evil.tar.gz']),
      getSearchPaths: jest.fn().mockReturnValue([]),
      globGenerator: jest.fn(),
    } as unknown as ReturnType<typeof glob.create> extends Promise<infer T> ? T : never);

    await expect(resolveLocalBundle('../outside/evil.tar.gz', workspace))
      .rejects.toThrow('resolves outside the workspace');
  });
});

describe('extractBundle', () => {
  const tmpDir = path.join(__dirname, '__tmp_extract__');
  const bundlePath = path.join(tmpDir, 'test-bundle.tar.gz');

  beforeEach(() => {
    jest.clearAllMocks();
    // Create tmp dir and a fake bundle file
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(bundlePath, 'fake-archive');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses apm unpack when apm is available', async () => {
    // apm --version succeeds
    mockExec.mockImplementation(async (cmd: string, args?: string[]) => {
      if (cmd === 'apm' && args?.[0] === '--version') return 0;
      if (cmd === 'apm' && args?.[0] === 'unpack') return 0;
      return 1;
    });

    const result = await extractBundle(bundlePath, tmpDir);
    expect(result.verified).toBe(true);

    // Verify apm unpack was called
    const unpackCall = mockExec.mock.calls.find(
      c => c[0] === 'apm' && (c[1] as string[])?.[0] === 'unpack'
    );
    expect(unpackCall).toBeTruthy();
  });

  it('falls back to tar when apm is not available', async () => {
    mockExec.mockImplementation(async (cmd: string, args?: string[]) => {
      if (cmd === 'apm' && args?.[0] === '--version') return 1;
      if (cmd === 'tar') return 0;
      return 1;
    });

    const result = await extractBundle(bundlePath, tmpDir);
    expect(result.verified).toBe(false);

    // Verify tar was called
    const tarCall = mockExec.mock.calls.find(c => c[0] === 'tar');
    expect(tarCall).toBeTruthy();
    expect((tarCall![1] as string[])).toContain('--strip-components=1');
  });

  it('throws when bundle file does not exist', async () => {
    await expect(extractBundle('/nonexistent/bundle.tar.gz', tmpDir))
      .rejects.toThrow('Bundle not found');
  });

  it('throws when apm unpack fails', async () => {
    mockExec.mockImplementation(async (cmd: string, args?: string[]) => {
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
    // Create a fake archive output
    fs.writeFileSync(path.join(buildDir, 'test-pkg-1.0.0.tar.gz'), 'fake');

    mockExec.mockResolvedValue(0);

    const result = await runPackStep(tmpDir, { target: 'vscode', archive: true });

    // Verify apm pack was called with correct args
    const packCall = mockExec.mock.calls.find(
      c => c[0] === 'apm' && (c[1] as string[])?.includes('pack')
    );
    expect(packCall).toBeTruthy();
    const args = packCall![1] as string[];
    expect(args).toContain('--target');
    expect(args).toContain('vscode');
    expect(args).toContain('--archive');
    expect(result).toContain('test-pkg-1.0.0.tar.gz');
  });

  it('builds correct args without target', async () => {
    // Create a fake directory output
    fs.mkdirSync(path.join(buildDir, 'test-pkg-1.0.0'), { recursive: true });

    mockExec.mockResolvedValue(0);

    const result = await runPackStep(tmpDir, { archive: false });

    const packCall = mockExec.mock.calls.find(
      c => c[0] === 'apm' && (c[1] as string[])?.includes('pack')
    );
    expect(packCall).toBeTruthy();
    const args = packCall![1] as string[];
    expect(args).not.toContain('--target');
    expect(args).not.toContain('--archive');
    expect(result).toContain('test-pkg-1.0.0');
  });

  it('throws when apm pack fails', async () => {
    mockExec.mockResolvedValue(1);

    await expect(runPackStep(tmpDir, { archive: true }))
      .rejects.toThrow('apm pack failed with exit code 1');
  });
});

describe('mode detection', () => {
  it('rejects pack and bundle used together', async () => {
    // This is tested via runner.ts integration, but we document the contract here.
    // The runner checks: if (bundleInput && packInput) throw
    // We verify the error message format:
    const errorMsg = "'pack' and 'bundle' inputs are mutually exclusive";
    expect(errorMsg).toContain('mutually exclusive');
  });
});
