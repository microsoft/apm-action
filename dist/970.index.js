export const id = 970;
export const ids = [970];
export const modules = {

/***/ 2970:
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   logCollisionPolicy: () => (/* binding */ logCollisionPolicy),
/* harmony export */   parseBundleListFile: () => (/* binding */ parseBundleListFile),
/* harmony export */   previewBundleFiles: () => (/* binding */ previewBundleFiles),
/* harmony export */   restoreMultiBundles: () => (/* binding */ restoreMultiBundles)
/* harmony export */ });
/* unused harmony exports TOKEN_ENV_DENYLIST, DEFAULT_MAX_BUNDLES, buildStrippedEnv */
/* harmony import */ var _actions_core__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(6058);
/* harmony import */ var _actions_exec__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(382);
/* harmony import */ var fs__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(9896);
/* harmony import */ var fs__WEBPACK_IMPORTED_MODULE_2___default = /*#__PURE__*/__webpack_require__.n(fs__WEBPACK_IMPORTED_MODULE_2__);
/* harmony import */ var path__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(6928);
/* harmony import */ var path__WEBPACK_IMPORTED_MODULE_3___default = /*#__PURE__*/__webpack_require__.n(path__WEBPACK_IMPORTED_MODULE_3__);
// Gap #1 resolution: `apm unpack --dry-run` IS available in the installed apm CLI
// (verified via `apm unpack --help` during Phase 2). However, full collision
// detection across N bundles is deferred to a follow-up PR per the design plan;
// `previewBundleFiles` is therefore stubbed to return an empty CollisionReport.




/**
 * Env-var denylist stripped from the apm unpack subprocess (B7).
 *
 * Includes:
 * - APM-recognised credentials: GITHUB_APM_PAT, ADO_APM_PAT.
 * - GitHub CLI / Actions token aliases that APM may auto-detect now or in
 *   future releases: GITHUB_TOKEN, GH_TOKEN.
 * - Runner-scoped tokens with high blast radius if exfiltrated by a malicious
 *   bundle's hypothetical lifecycle hook: ACTIONS_RUNTIME_TOKEN (cache write),
 *   ACTIONS_ID_TOKEN_REQUEST_TOKEN (OIDC federation).
 *
 * Defence-in-depth: `apm unpack` itself does not need any of these, and the
 * restore-side multi-bundle path performs no authenticated network calls.
 */
const TOKEN_ENV_DENYLIST = [
    'GITHUB_APM_PAT',
    'ADO_APM_PAT',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'ACTIONS_RUNTIME_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
];
/** Default cap on the number of bundles a single list file may contain (B5). */
const DEFAULT_MAX_BUNDLES = 64;
/**
 * Build a sanitised env for the apm unpack subprocess: process.env with the
 * token denylist removed. Defence-in-depth so a malicious bundle's lifecycle
 * hooks (if any are ever introduced) cannot exfiltrate the runner's auth.
 */
function buildStrippedEnv() {
    // process.env is Record<string, string | undefined>. Filter undefined-valued
    // entries up-front so the returned record is genuinely Record<string, string>
    // without an unsafe `as` cast that hides the underlying type mismatch.
    const env = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined));
    for (const key of TOKEN_ENV_DENYLIST) {
        delete env[key];
    }
    return env;
}
/**
 * Parse a newline-separated bundle list file into validated, deduped paths.
 *
 * Rules:
 * - File must exist and be readable (hard error with path + cwd).
 * - UTF-8 only (hard error on decode failure).
 * - Lines starting with '#' are comments (skipped).
 * - Blank lines are skipped.
 * - '..' segment in any path -> reject with line number (B3).
 * - Relative paths resolved against opts.workspaceDir; rejected if they escape it (B1).
 * - Absolute paths allowed (matches existing bundle: behaviour, B1).
 * - Each entry must end in `.tar.gz` (defence-in-depth + clear early failure
 *   if a user accidentally points at a directory or wrong file). Glob patterns
 *   are NOT expanded; use `find ... | sort` to generate the list yourself.
 * - Empty list after stripping -> hard error.
 * - Duplicates deduped silently (first occurrence wins).
 * - Cap at opts.maxBundles (default 64, env APM_MAX_BUNDLES) (B5).
 */
function parseBundleListFile(filePath, opts) {
    const cwd = process.cwd();
    const resolvedListPath = path__WEBPACK_IMPORTED_MODULE_3__.isAbsolute(filePath) ? filePath : path__WEBPACK_IMPORTED_MODULE_3__.resolve(cwd, filePath);
    if (!fs__WEBPACK_IMPORTED_MODULE_2__.existsSync(resolvedListPath)) {
        throw new Error(`bundles-file not found: ${filePath} (resolved: ${resolvedListPath}, cwd: ${cwd})`);
    }
    // Read as Buffer first so we can validate UTF-8 (B2).
    let raw;
    try {
        raw = fs__WEBPACK_IMPORTED_MODULE_2__.readFileSync(resolvedListPath);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`bundles-file unreadable: ${resolvedListPath}: ${msg}`);
    }
    // Strict UTF-8 decode using TextDecoder with fatal: true.
    let content;
    try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    }
    catch {
        throw new Error(`bundles-file is not valid UTF-8: ${resolvedListPath}`);
    }
    const workspaceDir = opts?.workspaceDir
        ?? process.env.GITHUB_WORKSPACE
        ?? cwd;
    const resolvedWorkspace = path__WEBPACK_IMPORTED_MODULE_3__.resolve(workspaceDir);
    const envCap = parseInt(process.env.APM_MAX_BUNDLES || '', 10);
    const maxBundles = Number.isFinite(envCap) && envCap > 0
        ? envCap
        : (opts?.maxBundles ?? DEFAULT_MAX_BUNDLES);
    const lines = content.split(/\r?\n/);
    const seen = new Set();
    const result = [];
    for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        const trimmed = lines[i].trim();
        if (!trimmed)
            continue;
        if (trimmed.startsWith('#'))
            continue;
        // Reject any '..' segment before resolving (B3). Normalise both '/' and '\'.
        const segments = trimmed.split(/[\\/]+/);
        if (segments.some(seg => seg === '..')) {
            throw new Error(`bundles-file line ${lineNum}: rejected '..' segment in path: ${trimmed}`);
        }
        // Require .tar.gz extension. Globs are not expanded; bare paths only.
        // Catches mis-configured list files (typo, directory, or wildcard left
        // unexpanded) at parse time rather than surfacing as a confusing tar error.
        if (!trimmed.toLowerCase().endsWith('.tar.gz')) {
            throw new Error(`bundles-file line ${lineNum}: entry must end in '.tar.gz' `
                + `(globs are not expanded; use find or ls to generate the list): ${trimmed}`);
        }
        const isAbs = path__WEBPACK_IMPORTED_MODULE_3__.isAbsolute(trimmed);
        const resolved = isAbs ? path__WEBPACK_IMPORTED_MODULE_3__.resolve(trimmed) : path__WEBPACK_IMPORTED_MODULE_3__.resolve(resolvedWorkspace, trimmed);
        // Workspace escape check (B1) -- relative paths only. Absolute paths are
        // user-explicit and allowed outside the workspace (mirrors bundler.ts).
        if (!isAbs) {
            const rel = path__WEBPACK_IMPORTED_MODULE_3__.relative(resolvedWorkspace, resolved);
            if (rel.startsWith('..') || path__WEBPACK_IMPORTED_MODULE_3__.isAbsolute(rel)) {
                throw new Error(`bundles-file line ${lineNum}: relative path escapes workspace ${resolvedWorkspace}: ${trimmed}`);
            }
        }
        if (seen.has(resolved))
            continue;
        seen.add(resolved);
        result.push(resolved);
    }
    if (result.length === 0) {
        throw new Error(`bundles-file is empty after stripping comments and blank lines: ${resolvedListPath}`);
    }
    if (result.length > maxBundles) {
        throw new Error(`bundles-file contains ${result.length} bundles (max ${maxBundles})`);
    }
    return result;
}
/**
 * Preview file collisions across N bundles without extracting.
 *
 * NOTE: Stubbed for v1.5.0 -- returns an empty CollisionReport. Full
 * implementation (which would shell out to `apm unpack --dry-run` and
 * aggregate file lists across bundles, distinguishing same-SHA from
 * different-SHA overlaps) is planned for v1.6.0. The restore loop is NOT
 * blocked on this; the policy is documented up-front via
 * `logCollisionPolicy()` so users are not surprised by silent overwrites.
 *
 * The function is wired into the runner today so its call site is real,
 * not dead code -- the v1.6.0 follow-up only swaps the implementation.
 */
async function previewBundleFiles(bundles) {
    void bundles;
    _actions_core__WEBPACK_IMPORTED_MODULE_0__/* .debug */ .Yz('previewBundleFiles: dry-run aggregation not yet implemented; returning empty report');
    return { sameSha: [], differentSha: [] };
}
/**
 * Emit a single, explicit policy banner BEFORE the restore loop runs so the
 * user is never surprised by silent overwrites. No-op for the single-bundle
 * case (no possible collisions). Intentionally `core.warning` not `core.info`
 * so it is annotated visibly in the GitHub Actions summary.
 */
function logCollisionPolicy(bundleCount) {
    if (bundleCount <= 1)
        return;
    _actions_core__WEBPACK_IMPORTED_MODULE_0__/* .warning */ .$e(`Multi-bundle restore: ${bundleCount} bundles will be applied in list order. `
        + `On file conflicts, later bundles overwrite earlier bundles silently. `
        + `Per-file SHA collision detection is planned for v1.6.0. `
        + `Until then, ensure the bundle list is in your intended precedence order.`);
}
/**
 * Restore N bundles into the same workspace directory, in caller-specified order.
 *
 * - Verifies `apm` is on PATH (B4: hard fail, no fallback).
 * - Loops through bundles in order, calling `apm unpack <bundle> -o <outputDir>`.
 * - Subprocess env has GITHUB_APM_PAT, ADO_APM_PAT, GITHUB_TOKEN stripped (B7).
 * - Subprocess uses argv array, not shell string (B8).
 * - Fail-fast: if bundle K fails, throw with index K, path, and stderr.
 * - Returns count + empty CollisionReport (collision detection deferred).
 *
 * @param bundles   Ordered array of absolute bundle paths (from parseBundleListFile).
 * @param outputDir Workspace directory to restore into.
 */
async function restoreMultiBundles(bundles, outputDir) {
    // B4: hard-fail if apm is not on PATH. Caller is expected to have invoked
    // ensureApmInstalled() already; this is a defensive check, not a fallback.
    const apmAvailable = await _actions_exec__WEBPACK_IMPORTED_MODULE_1__/* .exec */ .m('apm', ['--version'], {
        ignoreReturnCode: true,
        silent: true,
    }).catch(() => 1) === 0;
    if (!apmAvailable) {
        throw new Error('apm CLI not found on PATH. Multi-bundle restore requires APM to be installed; '
            + 'ensure ensureApmInstalled() ran before restoreMultiBundles().');
    }
    const resolvedOutput = path__WEBPACK_IMPORTED_MODULE_3__.resolve(outputDir);
    const env = buildStrippedEnv();
    const total = bundles.length;
    for (let i = 0; i < total; i++) {
        const bundle = bundles[i];
        const human = `bundle ${i + 1} of ${total}`;
        _actions_core__WEBPACK_IMPORTED_MODULE_0__/* .info */ .pq(`[${human}] Unpacking: ${bundle}`);
        let stderr = '';
        const rc = await _actions_exec__WEBPACK_IMPORTED_MODULE_1__/* .exec */ .m('apm', ['unpack', bundle, '-o', resolvedOutput], {
            ignoreReturnCode: true,
            env,
            listeners: {
                stderr: (data) => { stderr += data.toString(); },
            },
        });
        if (rc !== 0) {
            const tail = stderr.trim().split(/\r?\n/).slice(-10).join('\n');
            throw new Error(`apm unpack failed for ${human} (path: ${bundle}, exit code: ${rc})`
                + (tail ? `\nstderr:\n${tail}` : ''));
        }
        // Per-bundle confirmation so a stalled run is debuggable from the log
        // alone without re-reading the surrounding 'Unpacking' lines.
        _actions_core__WEBPACK_IMPORTED_MODULE_0__/* .info */ .pq(`[${human}] OK`);
    }
    return {
        count: total,
        collisions: { sameSha: [], differentSha: [] },
    };
}


/***/ })

};

//# sourceMappingURL=970.index.js.map