import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const mockInfo = jest.fn();
const mockGetInput = jest.fn();
const mockAddPath = jest.fn();

jest.unstable_mockModule('@actions/core', () => ({
  info: mockInfo,
  getInput: mockGetInput,
  addPath: mockAddPath,
}));

const mockExec = jest.fn<(cmd: string, args?: string[], opts?: unknown) => Promise<number>>();
const mockGetExecOutput = jest.fn<
  (cmd: string, args?: string[], opts?: unknown) => Promise<{ exitCode: number; stdout: string; stderr: string }>
>();
jest.unstable_mockModule('@actions/exec', () => ({
  exec: mockExec,
  getExecOutput: mockGetExecOutput,
}));

const mockDownloadTool = jest.fn<(url: string) => Promise<string>>();
const mockExtractTar = jest.fn<(file: string) => Promise<string>>();
const mockCacheDir = jest.fn<(dir: string, tool: string, ver: string) => Promise<string>>();
const mockFind = jest.fn<(tool: string, ver: string) => string>();

jest.unstable_mockModule('@actions/tool-cache', () => ({
  downloadTool: mockDownloadTool,
  extractTar: mockExtractTar,
  cacheDir: mockCacheDir,
  find: mockFind,
}));

const originalFetch = globalThis.fetch;
const mockFetch = jest.fn<typeof globalThis.fetch>();

const { getAssetSuffix, resolveDownloadUrl, ensureApmInstalled } = await import('../installer.js');

describe('getAssetSuffix', () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'arch', { value: originalArch });
  });

  it('returns darwin-arm64 for macOS ARM', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    expect(getAssetSuffix()).toBe('darwin-arm64');
  });

  it('returns linux-x86_64 for Linux x64', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    expect(getAssetSuffix()).toBe('linux-x86_64');
  });

  it('returns darwin-x86_64 for macOS x64', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    expect(getAssetSuffix()).toBe('darwin-x86_64');
  });

  it('returns linux-arm64 for Linux ARM', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    expect(getAssetSuffix()).toBe('linux-arm64');
  });

  it('throws on unsupported platform', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    expect(() => getAssetSuffix()).toThrow('Unsupported platform: win32');
  });

  it('throws on unsupported architecture', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 's390x' });
    expect(() => getAssetSuffix()).toThrow('Unsupported architecture: s390x');
  });
});

describe('resolveDownloadUrl', () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    mockGetInput.mockReturnValue('');
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'arch', { value: originalArch });
    globalThis.fetch = originalFetch;
  });

  it('resolves latest version via GitHub API', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v0.7.7' }),
    } as Response);

    const result = await resolveDownloadUrl('latest');
    expect(result.resolvedVersion).toBe('0.7.7');
    expect(result.url).toBe('https://github.com/microsoft/apm/releases/download/v0.7.7/apm-linux-x86_64.tar.gz');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/microsoft/apm/releases/latest',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/vnd.github+json' }) })
    );
  });

  it('sends auth header when github-token is available', async () => {
    mockGetInput.mockImplementation(((name: string) => name === 'github-token' ? 'ghp_test123' : '') as unknown as () => void);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v0.7.7' }),
    } as Response);

    await resolveDownloadUrl('latest');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/microsoft/apm/releases/latest',
      { headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ghp_test123' } }
    );
  });

  it('throws when GitHub API returns error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as Response);

    await expect(resolveDownloadUrl('latest')).rejects.toThrow('Failed to fetch latest release: 404 Not Found');
  });

  it('constructs URL for pinned version without v prefix', async () => {
    const result = await resolveDownloadUrl('0.7.5');
    expect(result.resolvedVersion).toBe('0.7.5');
    expect(result.url).toBe('https://github.com/microsoft/apm/releases/download/v0.7.5/apm-linux-x86_64.tar.gz');
  });

  it('constructs URL for pinned version with v prefix', async () => {
    const result = await resolveDownloadUrl('v0.7.5');
    expect(result.resolvedVersion).toBe('0.7.5');
    expect(result.url).toBe('https://github.com/microsoft/apm/releases/download/v0.7.5/apm-linux-x86_64.tar.gz');
  });
});

describe('ensureApmInstalled', () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    mockGetInput.mockImplementation(((name: string) => {
      if (name === 'apm-version') return '0.7.5';
      if (name === 'github-token') return 'ghp_mock';
      return '';
    }) as unknown as () => void);
    mockFind.mockReturnValue('');
    mockDownloadTool.mockResolvedValue('/tmp/download');
    mockExtractTar.mockResolvedValue('/tmp/extracted');
    mockCacheDir.mockResolvedValue('/opt/hostedtoolcache/apm/0.7.5/x64');
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'arch', { value: originalArch });
    globalThis.fetch = originalFetch;
  });

  it('explicit apm-version always installs the requested version (does not reuse PATH apm)', async () => {
    // Even if apm is already on PATH at some other version, an explicit
    // apm-version input must install that version. probePathVersion is not
    // even consulted for explicit versions.
    mockExec.mockResolvedValue(0);

    const result = await ensureApmInstalled();

    expect(mockGetExecOutput).not.toHaveBeenCalled();
    expect(mockDownloadTool).toHaveBeenCalledWith(
      'https://github.com/microsoft/apm/releases/download/v0.7.5/apm-linux-x86_64.tar.gz',
    );
    expect(result.resolvedVersion).toBe('0.7.5');
    expect(result.binaryPath).toContain('apm');
  });

  it('downloads and caches when not in tool cache', async () => {
    // Only one exec call now: the post-install --version verify.
    mockExec.mockResolvedValue(0);

    await ensureApmInstalled();

    expect(mockDownloadTool).toHaveBeenCalledWith(
      'https://github.com/microsoft/apm/releases/download/v0.7.5/apm-linux-x86_64.tar.gz',
    );
    expect(mockExtractTar).toHaveBeenCalledWith('/tmp/download');
    expect(mockCacheDir).toHaveBeenCalledWith(
      expect.stringContaining('apm-linux-x86_64'),
      'apm',
      '0.7.5',
    );
    expect(mockAddPath).toHaveBeenCalledWith('/opt/hostedtoolcache/apm/0.7.5/x64');
  });

  it('uses tool cache when available', async () => {
    mockExec.mockResolvedValue(0);
    mockFind.mockReturnValue('/opt/hostedtoolcache/apm/0.7.5/x64');

    await ensureApmInstalled();

    expect(mockDownloadTool).not.toHaveBeenCalled();
    expect(mockAddPath).toHaveBeenCalledWith('/opt/hostedtoolcache/apm/0.7.5/x64');
    expect(mockInfo).toHaveBeenCalledWith('APM 0.7.5 found in tool cache');
  });

  it('throws when verification fails', async () => {
    mockExec.mockResolvedValue(1);

    await expect(ensureApmInstalled()).rejects.toThrow('APM installation verification failed');
  });

  it('latest reuses apm already on PATH if probe succeeds', async () => {
    mockGetInput.mockImplementation(((name: string) => {
      if (name === 'apm-version') return 'latest';
      if (name === 'github-token') return 'ghp_mock';
      return '';
    }) as unknown as () => void);
    // First call: probe `apm --version`. Second call: `which apm` to resolve binary path.
    mockGetExecOutput
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'apm 0.11.0\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '/usr/local/bin/apm\n', stderr: '' });

    const result = await ensureApmInstalled();

    expect(mockDownloadTool).not.toHaveBeenCalled();
    expect(result.resolvedVersion).toBe('0.11.0');
    expect(result.toolDir).toBe('');
    expect(result.binaryPath).toBe('/usr/local/bin/apm');
  });

  it('latest reuses apm on PATH and tolerates failed which probe (binaryPath empty)', async () => {
    mockGetInput.mockImplementation(((name: string) => {
      if (name === 'apm-version') return 'latest';
      if (name === 'github-token') return 'ghp_mock';
      return '';
    }) as unknown as () => void);
    mockGetExecOutput
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'apm 0.11.0\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'which: command not found' });

    const result = await ensureApmInstalled();

    expect(result.resolvedVersion).toBe('0.11.0');
    expect(result.binaryPath).toBe('');
  });

  it('latest installs from GitHub when probe finds no apm on PATH', async () => {
    mockGetInput.mockImplementation(((name: string) => {
      if (name === 'apm-version') return 'latest';
      if (name === 'github-token') return 'ghp_mock';
      return '';
    }) as unknown as () => void);
    mockGetExecOutput.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'not found' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v0.7.7' }),
    } as Response);
    mockExec.mockResolvedValue(0);

    await ensureApmInstalled();

    expect(mockDownloadTool).toHaveBeenCalledWith(
      'https://github.com/microsoft/apm/releases/download/v0.7.7/apm-linux-x86_64.tar.gz',
    );
  });
});
