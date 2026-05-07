# Changelog

All notable changes to `microsoft/apm-action` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The floating `v1` tag tracks the latest `1.x` release. Consumers pinning
`microsoft/apm-action@v1` receive minor and patch updates automatically.

## [1.7.0] - 2026-05-07

### Added

- **`target` input now flows into the generated `apm.yml` in isolated mode** ([#33]). Required by APM v0.12.3+, which rejects `apm install` with exit 2 ("No harness detected") when the project has no harness signal. Previously the action discarded the `target:` input in isolated mode, breaking every gh-aw-style consumer that relies on inline `dependencies:` without a checked-in `apm.yml`.
- **Strict allowlist validation on the `target` input** ([#34]). The value flows verbatim into a generated YAML scalar and into `apm pack --target`. A per-token regex (`^[a-z][a-z0-9-]{0,31}$`, comma-separated for the multi-target form) now rejects newlines, `:`, `#`, quotes, and stray whitespace before any install/audit/compile work runs, closing a YAML-injection / CLI flag-smuggling vector.

### Changed

- **`apm-version` default pinned to `0.12.3`** ([#33], was `latest`). Floating to `latest` exposed every consumer to silent breakage when APM shipped strict harness detection in v0.12.3. Consumers can still opt in to floating with `apm-version: latest`.
- **`vscode` removed from the documented `target` allowlist** ([#33]). APM v0.12.3 dropped the alias; `copilot` is the replacement.

### Why these changes

APM v0.12.3 made harness detection strict (no more silent default-to-copilot). Every workflow using this action in isolated mode broke overnight because the action never persisted the `target` input. Fixing the propagation closes the immediate breakage; pinning `apm-version` ensures the next APM behaviour change is opt-in for downstream consumers rather than a Monday-morning incident; and validating the input shuts a YAML/CLI injection hole that the propagation work would otherwise have widened.

[#33]: https://github.com/microsoft/apm-action/pull/33
[#34]: https://github.com/microsoft/apm-action/pull/34

## [1.6.0] - 2026-05-02

### Added

- **`setup-only` mode** ([#31], closes [#24]). New input `setup-only: 'true'` installs the APM CLI onto `PATH` and exits, mirroring the `actions/setup-node` pattern. No `apm.yml` is read, no `apm install` runs, no primitives are deployed. Lets workflows compose `apm` invocations imperatively across multiple steps.
- **`bundle-format` input** ([#31]). Controls the layout produced by `apm pack`: `apm` (default, restorable by this action) or `plugin` (Claude Code marketplace layout). Defaults to `apm` so existing pack -> restore round-trips keep working regardless of changes to the upstream `apm pack` CLI default.
- **`apm-version` output** ([#31]). Resolved APM CLI version string. Always set.
- **`apm-path` output** ([#31]). Absolute path to the resolved `apm` binary. Resolved via tool-cache when the action installed APM, or via `which apm` when reusing a pre-existing CLI on `PATH`.
- **`bundle-format` output** ([#31]). Format of the produced or restored bundle. Set in pack and single-bundle restore modes.
- **Plugin-bundle detection in restore paths** ([#31]). Single-bundle and multi-bundle restore detect plugin-format archives via `tar tzf` and reject them with an actionable error that names the archive and points at the upstream tracking issue. Prevents silent corruption when a plugin bundle is fed into a restore step.

### Changed

- **Installer respects explicit `apm-version`** ([#31]). When an explicit version is requested (e.g. `apm-version: 0.11.0`), the action now always installs that version into the tool cache rather than short-circuiting to whatever `apm` happens to be on `PATH`. The resolved version now matches the requested version. `apm-version: latest` (the default) still reuses an APM already on `PATH` when available.
- **Action description rewritten** ([#31]) to call out setup-only, plugin-format opt-in, and the defensive `bundle-format: apm` default.

### Why these changes

The upstream `apm` CLI is changing the default `apm pack` format from `apm` to `plugin` in the next consumer-facing release (apm 0.12). Plugin bundles do not contain `apm.lock.yaml`, so `apm unpack` (and therefore this action's restore path) cannot consume them. Pinning `bundle-format: apm` in the pack call keeps every existing `microsoft/apm-action` consumer green when apm 0.12 ships, and the new `bundle-format: plugin` opt-in lets marketplace publishers produce Claude Code plugin bundles without leaving the action.

`setup-only` closes a long-standing gap: workflows that want to script `apm` calls (multi-step compose, pre-flight checks, ad-hoc `apm pack` with custom flags) previously had to install APM by hand. The new mode mirrors `actions/setup-node` so authors can apply familiar CI patterns.

## [1.5.1] - 2026-04-28

### Security

- Bump `handlebars` (dev dependency) from 4.7.8 to 4.7.9 to clear CVE-2024-4068 (prototype pollution; transitive `braces` advisory chain) ([#23]). No runtime behavior changes -- `handlebars` is only used by the test toolchain.

### Changed

- Floating `v1` tag moved to `v1.5.1` (was previously stuck on `v1.4.2`). Consumers pinning `microsoft/apm-action@v1` now receive the patch automatically.

## [1.5.0] - 2026-04-28

### Added

- **Multi-bundle restore via `bundles-file:` input** ([#30]). Restore multiple APM-format bundles in a single step by providing a YAML manifest listing each bundle path and target. Complements the existing single-bundle `bundle-path:` mode for monorepos and matrix workflows that materialize several plugins at once.

## [1.4.2] - 2026-04-24

### Fixed

- **`restore` mode no longer dirties the workspace** ([#27]). The action now installs the APM CLI and shells out to `apm unpack` instead of doing its own extraction inside the runner workspace, so the restore step leaves no untracked files behind. Fixes intermittent CI failures when downstream steps inspect `git status`.

### Security

- Bump `undici` from 6.23.0 to 6.24.1 ([#22]).

### Dependencies

- Bump `picomatch` (transitive) ([#20]).
- Bump `flatted` (dev dependency) from 3.3.4 to 3.4.2 ([#17]).

## [1.4.1] - 2026-03-26

### Fixed

- **Do not shadow caller `GITHUB_TOKEN` with `GITHUB_APM_PAT`** ([#21]). When the calling workflow already exports `GITHUB_TOKEN`, the action preserves it instead of overwriting it with the value forwarded as `GITHUB_APM_PAT`. Restores the documented two-token model for steps that follow `apm-action` and rely on the workflow's own token.

## [1.4.0] - 2026-03-22

### Added

- **Auto-forward `github-token` as `GITHUB_APM_PAT`** ([#19]). The token supplied via the `github-token:` input is now exported to the APM subprocess as `GITHUB_APM_PAT`, unlocking private-repo dependency resolution without requiring the workflow author to set the env var by hand. Documented the private-repo authentication flow end-to-end in the README.

## [1.3.4] - 2026-03-19

### Fixed

- **Preserve caller's `GITHUB_TOKEN` when already set in environment** ([#16]). Hardening pass on the token-forwarding logic introduced in 1.3.3.

## [1.3.3] - 2026-03-19

### Fixed

- **Pass `github-token` input to APM subprocess as `GITHUB_TOKEN`** ([#15]). The token supplied to the action is now propagated into the `apm` subprocess environment, fixing private-repo install failures in default-mode runs.

## [1.3.2] - 2026-03-17

### Added

- **`audit-report` input for SARIF audit report generation** ([#14]). Opt-in flag that runs `apm audit` and uploads a SARIF report to the GitHub code-scanning UI, plus a markdown summary in the job log. Lets security teams surface APM dependency findings alongside the rest of their static-analysis signals.

### Documentation

- README aligned with APM's two-layer security model (token resolution + audit gating).

## [1.3.1] - 2026-03-11

### Fixed

- **Implement version pinning with `@actions/tool-cache` v4** ([#11]). `apm-version: <pinned>` now reliably installs the requested version into the runner's tool cache instead of falling back to `apm@latest` from the install script.

## [1.3.0] - 2026-03-11

### Added

- **Mode-aware directory creation** ([#10]). Pack and restore modes create their working directories on demand with mode-appropriate guards; default mode fails fast when the working directory does not exist.
- **Allow absolute bundle paths in restore mode** ([#10]). `bundle-path:` accepts absolute paths, not only paths relative to `working-directory`.

### Changed

- **Validate inputs before touching the filesystem.** Front-loaded input validation so misconfigurations surface before any directory or env mutation.

### Documentation

- Use "non-isolated mode" instead of "default mode" in user-facing docs for clarity.

## [1.2.0] - 2026-03-10

### Fixed

- **`clearPrimitives` boundary anchored to `working-directory`, not `GITHUB_WORKSPACE`** ([#8]). Prevents the cleanup pass from reaching outside a custom working directory in monorepo layouts.

### Changed

- **Use `path.relative` for the traversal guard, wrap env mutation in try/finally** ([#9]). Hardens the path-traversal check and guarantees env restoration even when downstream steps throw.

### Documentation

- Add `copilot` as the primary target name in docs and `action.yml` ([#7]).

## [1.1.0] - 2026-03-10

### Added

- **`pack` and `restore` modes for CI/CD bundle workflows** ([#6]). The action gains two new modes alongside the default install mode: `pack` builds an APM-format bundle, `restore` re-materializes one. Together they enable publish/consume pipelines for compiled APM bundles.

### Changed

- **Migrate to ESM with `@actions/*` v3 + Node 24.** Brings the action onto the supported runtime and SDK line, with concurrency groups and per-job timeouts on internal CI.
- **Robust path-traversal check and deterministic bundle discovery** in restore mode.

## [1.0.0] - 2026-03-06

Initial public release.

### Added

- **Default install mode.** Reads `apm.yml`, runs `apm install`, deploys primitives into the calling workflow's workspace.
- **Compact summary-first output for GH AW truncation resilience** ([#4]). Emits a single high-signal summary line first so it survives downstream log truncation in GitHub Agentic Workflows.
- **Marketplace name set to "Setup APM"** ([#5]).
- **Microsoft OSS compliance baseline.** SECURITY.md ([#2]), CODEOWNERS, license, contributing guide, code of conduct, and CI pipeline.

[Unreleased]: https://github.com/microsoft/apm-action/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/microsoft/apm-action/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/microsoft/apm-action/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/microsoft/apm-action/compare/v1.4.2...v1.5.0
[1.4.2]: https://github.com/microsoft/apm-action/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/microsoft/apm-action/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/microsoft/apm-action/compare/v1.3.4...v1.4.0
[1.3.4]: https://github.com/microsoft/apm-action/compare/v1.3.3...v1.3.4
[1.3.3]: https://github.com/microsoft/apm-action/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/microsoft/apm-action/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/microsoft/apm-action/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/microsoft/apm-action/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/microsoft/apm-action/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/microsoft/apm-action/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/microsoft/apm-action/releases/tag/v1.0.0

[#2]: https://github.com/microsoft/apm-action/pull/2
[#4]: https://github.com/microsoft/apm-action/pull/4
[#5]: https://github.com/microsoft/apm-action/pull/5
[#6]: https://github.com/microsoft/apm-action/pull/6
[#7]: https://github.com/microsoft/apm-action/pull/7
[#8]: https://github.com/microsoft/apm-action/pull/8
[#9]: https://github.com/microsoft/apm-action/pull/9
[#10]: https://github.com/microsoft/apm-action/pull/10
[#11]: https://github.com/microsoft/apm-action/pull/11
[#14]: https://github.com/microsoft/apm-action/pull/14
[#15]: https://github.com/microsoft/apm-action/pull/15
[#16]: https://github.com/microsoft/apm-action/pull/16
[#17]: https://github.com/microsoft/apm-action/pull/17
[#19]: https://github.com/microsoft/apm-action/pull/19
[#20]: https://github.com/microsoft/apm-action/pull/20
[#21]: https://github.com/microsoft/apm-action/pull/21
[#22]: https://github.com/microsoft/apm-action/pull/22
[#23]: https://github.com/microsoft/apm-action/pull/23
[#24]: https://github.com/microsoft/apm-action/issues/24
[#27]: https://github.com/microsoft/apm-action/pull/27
[#30]: https://github.com/microsoft/apm-action/pull/30
[#31]: https://github.com/microsoft/apm-action/pull/31
