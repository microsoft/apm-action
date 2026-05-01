# APM Action

A GitHub Action that installs [APM (Agent Package Manager)](https://github.com/microsoft/apm) and deploys agent primitives (instructions, prompts, skills, agents) into your CI workflows. One line. Zero config.

📖 [APM Documentation](https://microsoft.github.io/apm) · [Security Model](https://microsoft.github.io/apm/enterprise/security/) · [CI/CD Guide](https://microsoft.github.io/apm/integrations/ci-cd/)

## Usage

```yaml
- uses: microsoft/apm-action@v1
```

This installs the APM CLI, reads your `apm.yml`, and runs `apm install`.

### With options

```yaml
- uses: microsoft/apm-action@v1
  with:
    compile: 'true'                    # generate AGENTS.md after install
    apm-version: '0.7.0'              # pin a specific APM version
    working-directory: './my-project'  # custom working directory
```

### Isolated mode (inline dependencies, no apm.yml needed)

```yaml
- uses: microsoft/apm-action@v1
  with:
    isolated: 'true'
    dependencies: |
      - microsoft/apm-sample-package
```

### Setup-only mode (install CLI, then exit)

Just install the APM CLI and put it on `PATH`, like `actions/setup-node`. Run any `apm` command yourself in subsequent steps. No `apm.yml` required, no install step runs.

```yaml
- uses: microsoft/apm-action@v1
  id: apm
  with:
    setup-only: 'true'
    apm-version: '0.11.0'

- run: apm --version
- run: apm pack -o build --format plugin
```

`setup-only: true` is mutually exclusive with `pack`, `bundle`, and `bundles-file`. The action will not read `apm.yml`, run `apm install`, or deploy primitives. Sets the `apm-version` and `apm-path` outputs so downstream steps can branch on the resolved CLI.

### Bundle format (`apm` vs `plugin`)

`apm pack` supports two layouts:

- `bundle-format: apm` (default) -- produces an APM bundle containing `apm.lock.yaml` and a `.github/` (or `.claude/`) tree. Restorable by this action via `bundle:` / `bundles-file:`. **Use this when the consumer is another `microsoft/apm-action` step.**
- `bundle-format: plugin` -- produces a Claude Code plugin bundle with `plugin.json` at the root and flat primitive directories (`agents/`, `skills/`, ...). **Use this when publishing to a Claude Code marketplace.** Plugin bundles are not restorable by this action; restore them with your plugin tooling.

```yaml
- uses: microsoft/apm-action@v1
  with:
    pack: 'true'
    bundle-format: 'plugin'    # opt-in; default is 'apm'
```

The `bundle-format` output reflects the format of the produced or restored bundle.

### Pack mode (produce a bundle)

Install dependencies, scan for hidden Unicode threats, and pack into a self-contained `.tar.gz` archive. Add `audit-report` to generate a SARIF report alongside the bundle:

```yaml
- uses: microsoft/apm-action@v1
  id: pack
  with:
    pack: 'true'
    target: 'copilot'
    audit-report: true

- uses: github/codeql-action/upload-sarif@v3
  if: always() && steps.pack.outputs.audit-report-path
  with:
    sarif_file: ${{ steps.pack.outputs.audit-report-path }}
    category: apm-audit

- uses: actions/upload-artifact@v4
  with:
    name: agent-bundle
    path: ${{ steps.pack.outputs.bundle-path }}
```

This works with all modes — `isolated`, inline `dependencies`, or from `apm.yml`.

### Restore mode (verified extraction)

Restore primitives from a bundle. The action installs APM (cached across runs) and uses `apm unpack` for integrity verification — no Python, minimal network. Only files listed in the bundle's lockfile (`deployed_files`) are written to `working-directory`; the lockfile and `apm.yml` themselves are not, so the workspace stays clean for downstream steps such as `git checkout`.

```yaml
- uses: actions/download-artifact@v4
  with:
    name: agent-bundle

- uses: microsoft/apm-action@v1
  with:
    bundle: './*.tar.gz'
```

<a id="multi-bundle-restore"></a>
### Multi-bundle restore (multi-org / multi-app)

**Why:** when you fan out a `pack` job across N GitHub Apps (or N orgs, or N teams) you end up with N separate bundle artifacts. Without `bundles-file`, the consumer job has to call `microsoft/apm-action@v1` N times in sequence, which adds latency and obscures which install came from which source. `bundles-file` lets a single restore step merge all N bundles into one workspace in caller-specified order. See [issue #29](https://github.com/microsoft/apm-action/issues/29) for the full rationale and diagrams.

**Backward compatibility:** existing single-`bundle` callers are unaffected. `bundles-file` is a new opt-in input; `pack`, `bundle`, and `bundles-file` are mutually exclusive (the action errors if more than one is set).

```yaml
# In a downstream job that consumes all bundles:
- uses: actions/download-artifact@v4
  with:
    pattern: apm-*
    path: /tmp/bundles

- run: find /tmp/bundles -name '*.tar.gz' | sort > /tmp/bundle-list.txt

- uses: microsoft/apm-action@v1
  id: restore
  with:
    bundles-file: /tmp/bundle-list.txt
    working-directory: /tmp/agent-workspace

- run: echo "Merged ${{ steps.restore.outputs.bundles-restored }} bundles into the workspace"
```

The `bundles-restored` output reports the integer count of bundles successfully merged, which is convenient for assertions and logging in downstream steps.

**Collision policy:** bundles are applied in list order; on file conflicts, later bundles overwrite earlier bundles. The action logs an explicit warning naming the bundle count before the restore loop begins, so the policy is never silent. Per-file SHA-aware collision detection is planned for v1.6.0.

### Cross-job artifact workflow

Pack once, restore everywhere — identical primitives across all consumer jobs.

```yaml
jobs:
  agent-config:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: microsoft/apm-action@v1
        id: pack
        with:
          pack: 'true'
          target: 'copilot'
      - uses: actions/upload-artifact@v4
        with:
          name: agent-bundle
          path: ${{ steps.pack.outputs.bundle-path }}

  lint:
    needs: agent-config
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: agent-bundle
      - uses: microsoft/apm-action@v1
        with:
          bundle: './*.tar.gz'
      # .github/ is ready — primitives deployed

  deploy:
    needs: agent-config
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: agent-bundle
      - uses: microsoft/apm-action@v1
        with:
          bundle: './*.tar.gz'
      # Same primitives, different job. Byte-identical.
```

### Security scanning

`apm install` automatically blocks packages with critical hidden-character findings — no configuration needed. Add `audit-report` for visibility: a SARIF report for [Code Scanning](https://docs.github.com/en/code-security/code-scanning) annotations and a markdown summary in `$GITHUB_STEP_SUMMARY`. See the [APM security model](https://microsoft.github.io/apm/enterprise/security/) for details.

```yaml
- uses: microsoft/apm-action@v1
  id: apm
  with:
    audit-report: true
- uses: github/codeql-action/upload-sarif@v3
  if: always() && steps.apm.outputs.audit-report-path
  with:
    sarif_file: ${{ steps.apm.outputs.audit-report-path }}
    category: apm-audit
```

## Private repo authentication

By default, `github-token` (which defaults to `${{ github.token }}`) is automatically forwarded to APM as `GITHUB_APM_PAT`. This means same-org private repos work with zero config.

```yaml
# Same-org private repos: zero config
- uses: microsoft/apm-action@v1
```

For cross-org private repos, pass a PAT with broader scope via the `github-token` input:

```yaml
# Cross-org private repos: pass a broader-scoped PAT
- uses: microsoft/apm-action@v1
  with:
    github-token: ${{ secrets.APM_PAT }}
```

For multi-org or multi-platform scenarios, use the `env:` block for full control. An explicit `GITHUB_APM_PAT` in `env:` always wins over the auto-forwarded value. (For the matrix-based fan-out pattern that pairs one App per matrix replica with [`bundles-file:`](#multi-bundle-restore), see [issue #29](https://github.com/microsoft/apm-action/issues/29).)

```yaml
# Multi-org / multi-platform: full control via env block
- uses: microsoft/apm-action@v1
  env:
    GITHUB_APM_PAT: ${{ secrets.APM_PAT }}
    GITHUB_APM_PAT_CONTOSO: ${{ secrets.APM_PAT_CONTOSO }}
    ADO_APM_PAT: ${{ secrets.ADO_PAT }}
    ARTIFACTORY_APM_TOKEN: ${{ secrets.ARTIFACTORY_TOKEN }}
```

> **Note:** GitHub Actions forbids secrets named with the `GITHUB_` prefix, so you cannot create a secret called `GITHUB_APM_PAT` directly. The auto-forward from `github-token` covers the common case. For cross-org tokens, name your secret something like `APM_PAT` and pass it via `github-token` or `env: GITHUB_APM_PAT`.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `working-directory` | No | `.` | Working directory for execution. Must exist in non-isolated mode (with your `apm.yml`). In `isolated`, `pack`, or `bundle` modes the directory is created automatically. |
| `apm-version` | No | `latest` | APM version to install |
| `github-token` | No | `${{ github.token }}` | GitHub token for API calls. Auto-forwarded as `GITHUB_APM_PAT` so same-org private repos work with zero config. Pass a broader-scoped PAT for cross-org access. |
| `script` | No | | APM script to run after install |
| `dependencies` | No | | YAML array of extra dependencies to install (additive to apm.yml) |
| `isolated` | No | `false` | Ignore apm.yml and clear pre-existing primitive dirs — install only inline dependencies |
| `compile` | No | `false` | Run `apm compile` after install to generate AGENTS.md |
| `pack` | No | `false` | Pack a bundle after install (produces `.tar.gz` by default) |
| `bundle-format` | No | `apm` | Bundle layout when `pack: true`. `apm` produces an APM bundle (with `apm.lock.yaml` and a `.github/` tree, restorable by this action). `plugin` produces a Claude Code plugin bundle (with `plugin.json` at the root, intended for marketplace consumption). |
| `setup-only` | No | `false` | Install the APM CLI and exit. No `apm.yml` is read, no `apm install` runs, no primitives are deployed. Mutually exclusive with `pack`, `bundle`, and `bundles-file`. |
| `bundle` | No | | Restore from a bundle (local path or glob). Installs APM and unpacks via `apm unpack` (verified). |
| `bundles-file` | No | | Path to a UTF-8 text file with one bundle path per line. Restores N bundles into a single workspace in caller-specified order (last wins on collisions). Mutually exclusive with `pack` and `bundle`. |
| `target` | No | | Bundle target: `copilot`, `vscode`, `claude`, or `all` (used with `pack: true`) |
| `archive` | No | `true` | Produce `.tar.gz` instead of directory (used with `pack: true`) |
| `audit-report` | No | | Generate a SARIF audit report (hidden Unicode scanning). `apm install` already blocks critical findings; this adds reporting for Code Scanning and a markdown summary in `$GITHUB_STEP_SUMMARY`. Set to `true` for default path, or provide a custom path. |

## Outputs

| Output | Description |
|---|---|
| `success` | Whether the action succeeded (`true`/`false`) |
| `apm-version` | Resolved APM CLI version (e.g. `0.11.0`). Always set. |
| `apm-path` | Absolute path to the resolved `apm` binary. Set when the action installs APM into the tool cache; empty when reusing a CLI already on `PATH`. |
| `bundle-format` | Format of the produced or restored bundle (`apm` or `plugin`). Set in pack and single-bundle restore modes. |
| `primitives-path` | Path where agent primitives were deployed (`.github`) |
| `bundle-path` | Path to the packed bundle (only set in pack mode) |
| `audit-report-path` | Path to the generated SARIF audit report (if `audit-report` was set) |
| `bundles-restored` | Number of bundles successfully restored (multi-bundle mode only) |

## Third-Party Dependencies

This action bundles the following open-source packages (see `dist/licenses.txt` for full license texts):

- [@actions/core](https://github.com/actions/toolkit) — GitHub Actions toolkit (MIT)
- [@actions/exec](https://github.com/actions/toolkit) — GitHub Actions exec helpers (MIT)
- [@actions/io](https://github.com/actions/toolkit) — GitHub Actions I/O helpers (MIT)
- [js-yaml](https://github.com/nodeca/js-yaml) — YAML parser (MIT)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
