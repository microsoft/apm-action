import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ESM mocking: set up mocks before dynamic imports.
const mockExec = jest.fn<(cmd: string, args?: string[], options?: object) => Promise<number>>();
const mockInfo = jest.fn();
const mockDebug = jest.fn();

jest.unstable_mockModule('@actions/core', () => ({
  info: mockInfo,
  debug: mockDebug,
  warning: jest.fn(),
}));

jest.unstable_mockModule('@actions/exec', () => ({
  exec: mockExec,
}));

const {
  parseBundleListFile,
  restoreMultiBundles,
  previewBundleFiles,
  buildStrippedEnv,
  TOKEN_ENV_DENYLIST,
  DEFAULT_MAX_BUNDLES,
} = await import('../multibundle.js');

// ---------------------------------------------------------------------------
// parseBundleListFile
// ---------------------------------------------------------------------------

describe('parseBundleListFile', () => {
  let tmpDir: string;
  let workspaceDir: string;
  let listFile: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-mb-parse-'));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-mb-ws-'));
    listFile = path.join(tmpDir, 'bundles.txt');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    delete process.env.APM_MAX_BUNDLES;
  });

  it('parses a valid 3-entry list into absolute paths', () => {
    // Pre-create the bundles inside workspace so the relative resolution lands
    // somewhere predictable. The parser does not check existence of bundles
    // themselves -- only of the list file.
    const a = path.join(workspaceDir, 'a.tar.gz');
    const b = path.join(workspaceDir, 'b.tar.gz');
    const c = path.join(workspaceDir, 'c.tar.gz');
    fs.writeFileSync(listFile, [a, b, c].join('\n'));

    const out = parseBundleListFile(listFile, { workspaceDir });
    expect(out).toEqual([a, b, c]);
  });

  it('strips lines starting with #', () => {
    const a = path.join(workspaceDir, 'a.tar.gz');
    const b = path.join(workspaceDir, 'b.tar.gz');
    fs.writeFileSync(listFile, [
      '# comment line',
      a,
      '#   another comment',
      b,
    ].join('\n'));

    const out = parseBundleListFile(listFile, { workspaceDir });
    expect(out).toEqual([a, b]);
  });

  it('strips blank lines and trims whitespace', () => {
    const a = path.join(workspaceDir, 'a.tar.gz');
    const b = path.join(workspaceDir, 'b.tar.gz');
    fs.writeFileSync(listFile, [
      '',
      `   ${a}   `,
      '\t',
      `\t${b}`,
      '',
    ].join('\n'));

    const out = parseBundleListFile(listFile, { workspaceDir });
    expect(out).toEqual([a, b]);
  });

  it('deduplicates preserving first occurrence', () => {
    const a = path.join(workspaceDir, 'a.tar.gz');
    const b = path.join(workspaceDir, 'b.tar.gz');
    fs.writeFileSync(listFile, [a, b, a, b, a].join('\n'));

    const out = parseBundleListFile(listFile, { workspaceDir });
    expect(out).toEqual([a, b]);
  });

  it('[B3] rejects ".." segment with line number in error', () => {
    fs.writeFileSync(listFile, [
      path.join(workspaceDir, 'ok.tar.gz'),
      '/tmp/bundles/../../../etc/passwd',
    ].join('\n'));

    expect(() => parseBundleListFile(listFile, { workspaceDir }))
      .toThrow(/line 2: rejected '\.\.' segment/);
  });

  it('[B1] rejects relative path escaping workspace', () => {
    fs.writeFileSync(listFile, 'subdir/../ok.tar.gz\n');
    // The '..' check fires first per the rule order; assert traversal is rejected.
    expect(() => parseBundleListFile(listFile, { workspaceDir }))
      .toThrow(/line 1: rejected '\.\.' segment/);
  });

  it('[B1] allows absolute paths outside workspace', () => {
    // gh-aw scenario: bundles downloaded to /tmp/, workspace in /home/runner/work/...
    const outside = path.resolve(tmpDir, 'outside.tar.gz');
    fs.writeFileSync(listFile, outside + '\n');

    const out = parseBundleListFile(listFile, { workspaceDir });
    expect(out).toEqual([outside]);
  });

  it('[B2] throws on non-UTF-8 file content', () => {
    // Lone 0xFF / 0xFE bytes are invalid UTF-8 leading bytes.
    fs.writeFileSync(listFile, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    expect(() => parseBundleListFile(listFile, { workspaceDir }))
      .toThrow(/not valid UTF-8/);
  });

  it('[B5] throws when list exceeds default cap of 64', () => {
    const lines: string[] = [];
    for (let i = 0; i < DEFAULT_MAX_BUNDLES + 1; i++) {
      lines.push(path.join(workspaceDir, `b${i}.tar.gz`));
    }
    fs.writeFileSync(listFile, lines.join('\n'));

    expect(() => parseBundleListFile(listFile, { workspaceDir }))
      .toThrow(`bundles-file contains 65 bundles (max 64)`);
  });

  it('[B5] respects APM_MAX_BUNDLES env override', () => {
    process.env.APM_MAX_BUNDLES = '2';
    const lines = [
      path.join(workspaceDir, 'a.tar.gz'),
      path.join(workspaceDir, 'b.tar.gz'),
      path.join(workspaceDir, 'c.tar.gz'),
    ];
    fs.writeFileSync(listFile, lines.join('\n'));

    expect(() => parseBundleListFile(listFile, { workspaceDir }))
      .toThrow(/contains 3 bundles \(max 2\)/);
  });

  it('throws when file does not exist with path and cwd', () => {
    const missing = path.join(tmpDir, 'nope.txt');
    expect(() => parseBundleListFile(missing, { workspaceDir }))
      .toThrow(/bundles-file not found.*cwd:/);
  });

  it('throws when list is empty after stripping', () => {
    fs.writeFileSync(listFile, '# only comments\n\n   \n# more\n');
    expect(() => parseBundleListFile(listFile, { workspaceDir }))
      .toThrow(/empty after stripping/);
  });
});

// ---------------------------------------------------------------------------
// restoreMultiBundles
// ---------------------------------------------------------------------------

describe('restoreMultiBundles', () => {
  let outDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-mb-out-'));
    // Default: apm --version succeeds, all unpack invocations succeed.
    mockExec.mockImplementation(async (cmd, args) => {
      if (cmd === 'apm' && args?.[0] === '--version') return 0;
      if (cmd === 'apm' && args?.[0] === 'unpack') return 0;
      return 1;
    });
  });

  afterEach(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('calls apm unpack per bundle in caller order', async () => {
    const bundles = ['/abs/a.tar.gz', '/abs/b.tar.gz', '/abs/c.tar.gz'];
    const result = await restoreMultiBundles(bundles, outDir);

    expect(result.count).toBe(3);
    expect(result.collisions).toEqual({ sameSha: [], differentSha: [] });

    const unpackCalls = mockExec.mock.calls.filter(
      c => c[0] === 'apm' && c[1]?.[0] === 'unpack',
    );
    expect(unpackCalls).toHaveLength(3);
    expect(unpackCalls[0][1]).toEqual(['unpack', '/abs/a.tar.gz', '-o', path.resolve(outDir)]);
    expect(unpackCalls[1][1]).toEqual(['unpack', '/abs/b.tar.gz', '-o', path.resolve(outDir)]);
    expect(unpackCalls[2][1]).toEqual(['unpack', '/abs/c.tar.gz', '-o', path.resolve(outDir)]);
  });

  it('[B7] subprocess env excludes GITHUB_APM_PAT, ADO_APM_PAT, GITHUB_TOKEN', async () => {
    // Set the tokens in the parent env so we can prove they are stripped.
    const prev = {
      a: process.env.GITHUB_APM_PAT,
      b: process.env.ADO_APM_PAT,
      c: process.env.GITHUB_TOKEN,
    };
    process.env.GITHUB_APM_PAT = 'pat-1';
    process.env.ADO_APM_PAT = 'pat-2';
    process.env.GITHUB_TOKEN = 'pat-3';

    try {
      await restoreMultiBundles(['/abs/a.tar.gz'], outDir);

      const unpack = mockExec.mock.calls.find(
        c => c[0] === 'apm' && c[1]?.[0] === 'unpack',
      );
      expect(unpack).toBeTruthy();
      const opts = unpack![2] as { env?: Record<string, string> };
      expect(opts?.env).toBeDefined();
      expect(opts.env!.GITHUB_APM_PAT).toBeUndefined();
      expect(opts.env!.ADO_APM_PAT).toBeUndefined();
      expect(opts.env!.GITHUB_TOKEN).toBeUndefined();
    } finally {
      if (prev.a === undefined) delete process.env.GITHUB_APM_PAT; else process.env.GITHUB_APM_PAT = prev.a;
      if (prev.b === undefined) delete process.env.ADO_APM_PAT;   else process.env.ADO_APM_PAT = prev.b;
      if (prev.c === undefined) delete process.env.GITHUB_TOKEN;  else process.env.GITHUB_TOKEN = prev.c;
    }
  });

  it('[B8] invokes apm via argv array, not shell', async () => {
    await restoreMultiBundles(['/abs/a.tar.gz'], outDir);
    const unpack = mockExec.mock.calls.find(
      c => c[0] === 'apm' && c[1]?.[0] === 'unpack',
    );
    expect(unpack).toBeTruthy();
    // argv array form: cmd is exactly 'apm' (not a shell string), args is an array.
    expect(unpack![0]).toBe('apm');
    expect(Array.isArray(unpack![1])).toBe(true);
  });

  it('[B4] hard-fails if apm is not on PATH', async () => {
    mockExec.mockImplementation(async (cmd, args) => {
      if (cmd === 'apm' && args?.[0] === '--version') return 1;
      return 0;
    });

    await expect(restoreMultiBundles(['/abs/a.tar.gz'], outDir))
      .rejects.toThrow(/apm CLI not found on PATH/);
  });

  it('fail-fast: stops at first failing bundle with index in message', async () => {
    let unpackIdx = 0;
    mockExec.mockImplementation(async (cmd, args) => {
      if (cmd === 'apm' && args?.[0] === '--version') return 0;
      if (cmd === 'apm' && args?.[0] === 'unpack') {
        unpackIdx++;
        return unpackIdx === 2 ? 7 : 0;
      }
      return 1;
    });

    const bundles = ['/abs/a.tar.gz', '/abs/b.tar.gz', '/abs/c.tar.gz'];
    await expect(restoreMultiBundles(bundles, outDir))
      .rejects.toThrow(/bundle 2 of 3.*\/abs\/b\.tar\.gz.*exit code: 7/s);

    const unpackCalls = mockExec.mock.calls.filter(
      c => c[0] === 'apm' && c[1]?.[0] === 'unpack',
    );
    // Only 2 unpack calls -- third bundle never attempted.
    expect(unpackCalls).toHaveLength(2);
  });

  it('[B9] does not reorder bundles', async () => {
    const bundles = ['/z.tar.gz', '/a.tar.gz', '/m.tar.gz'];
    await restoreMultiBundles(bundles, outDir);
    const order = mockExec.mock.calls
      .filter(c => c[0] === 'apm' && c[1]?.[0] === 'unpack')
      .map(c => c[1]![1]);
    expect(order).toEqual(['/z.tar.gz', '/a.tar.gz', '/m.tar.gz']);
  });
});

// ---------------------------------------------------------------------------
// previewBundleFiles
// ---------------------------------------------------------------------------

describe('previewBundleFiles', () => {
  it('returns empty CollisionReport (stub)', async () => {
    const report = await previewBundleFiles(['/a.tar.gz', '/b.tar.gz']);
    expect(report).toEqual({ sameSha: [], differentSha: [] });
  });
});

// ---------------------------------------------------------------------------
// buildStrippedEnv
// ---------------------------------------------------------------------------

describe('buildStrippedEnv', () => {
  it('[B7] deletes exactly GITHUB_APM_PAT, ADO_APM_PAT, GITHUB_TOKEN', () => {
    const prev = {
      a: process.env.GITHUB_APM_PAT,
      b: process.env.ADO_APM_PAT,
      c: process.env.GITHUB_TOKEN,
    };
    process.env.GITHUB_APM_PAT = 'x';
    process.env.ADO_APM_PAT = 'y';
    process.env.GITHUB_TOKEN = 'z';

    try {
      const env = buildStrippedEnv();
      for (const key of TOKEN_ENV_DENYLIST) {
        expect(env[key]).toBeUndefined();
      }
    } finally {
      if (prev.a === undefined) delete process.env.GITHUB_APM_PAT; else process.env.GITHUB_APM_PAT = prev.a;
      if (prev.b === undefined) delete process.env.ADO_APM_PAT;   else process.env.ADO_APM_PAT = prev.b;
      if (prev.c === undefined) delete process.env.GITHUB_TOKEN;  else process.env.GITHUB_TOKEN = prev.c;
    }
  });

  it('preserves PATH and other env vars', () => {
    process.env.MULTIBUNDLE_TEST_VAR = 'preserve-me';
    try {
      const env = buildStrippedEnv();
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.MULTIBUNDLE_TEST_VAR).toBe('preserve-me');
    } finally {
      delete process.env.MULTIBUNDLE_TEST_VAR;
    }
  });
});
