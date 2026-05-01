# Changelog

All notable changes to `microsoft/apm-action` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **`setup-only` mode** ([#24](https://github.com/microsoft/apm-action/issues/24)). New input `setup-only: 'true'` installs the APM CLI onto `PATH` and exits, mirroring the `actions/setup-node` pattern. No `apm.yml` is read, no `apm install` runs, no primitives are deployed. Lets workflows compose `apm` invocations imperatively across multiple steps.
- **`bundle-format` input.** New input controls the layout produced by `apm pack`: `apm` (default, restorable by this action) or `plugin` (Claude Code marketplace layout). Defaults to `apm` so existing pack -> restore round-trips keep working regardless of changes to the `apm pack` CLI default.
- **`apm-version` output.** Resolved APM CLI version string. Always set.
- **`apm-path` output.** Absolute path to the resolved `apm` binary. Empty when reusing a CLI already on `PATH`.
- **`bundle-format` output.** Format of the produced or restored bundle. Set in pack and single-bundle restore modes.
- **Plugin-bundle detection.** Single-bundle and multi-bundle restore paths detect plugin-format archives via `tar tzf` and reject them with an actionable error message that names the archive and points at the upstream tracking issue. Prevents silent corruption when a plugin bundle is fed into a restore step.

### Changed

- **Installer respects explicit `apm-version`.** When an explicit version is requested (e.g. `apm-version: 0.11.0`), the action now always installs that version into the tool cache rather than short-circuiting to whatever `apm` happens to be on `PATH`. This makes the resolved version match the requested version. `apm-version: latest` (the default) still reuses an APM already on `PATH` when available.
- **Action description rewritten** to call out setup-only, plugin-format opt-in, and the defensive `bundle-format: apm` default.

### Why these changes

The upstream `apm` CLI is changing the default `apm pack` format from `apm` to `plugin` in the next consumer-facing release. Plugin bundles do not contain `apm.lock.yaml`, so `apm unpack` (and therefore this action's restore path) cannot consume them. Pinning `bundle-format: apm` in the pack call keeps every existing `microsoft/apm-action` consumer green, and the new `bundle-format: plugin` opt-in lets marketplace publishers produce Claude Code plugin bundles without leaving the action.

`setup-only` closes a long-standing gap: workflows that want to script `apm` calls (multi-step compose, pre-flight checks, ad-hoc `apm pack` with custom flags) previously had to install APM by hand. The new mode mirrors `actions/setup-node` so authors can apply familiar CI patterns.
