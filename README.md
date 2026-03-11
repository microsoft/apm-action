# APM Action

A GitHub Action that installs [APM (Agent Package Manager)](https://github.com/microsoft/apm) and deploys agent primitives (instructions, prompts, skills, agents) into your CI workflows. One line. Zero config.

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

### Pack mode (produce a bundle)

Install dependencies and pack them into a self-contained `.tar.gz` archive. Combine with `actions/upload-artifact` to share across jobs.

```yaml
- uses: microsoft/apm-action@v1
  id: pack
  with:
    pack: 'true'
    target: 'copilot'

- uses: actions/upload-artifact@v4
  with:
    name: agent-bundle
    path: ${{ steps.pack.outputs.bundle-path }}
```

### Restore mode (zero-install)

Restore primitives from a bundle — no APM installation, no Python, no network. If APM happens to be on PATH, it uses `apm unpack` for integrity verification; otherwise it falls back to `tar xzf`.

```yaml
- uses: actions/download-artifact@v4
  with:
    name: agent-bundle

- uses: microsoft/apm-action@v1
  with:
    bundle: './*.tar.gz'
```

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

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `working-directory` | No | `.` | Working directory for execution. Must exist in default mode (with your `apm.yml`). In `isolated`, `pack`, or `bundle` modes the directory is created automatically. |
| `apm-version` | No | `latest` | APM version to install |
| `script` | No | | APM script to run after install |
| `dependencies` | No | | YAML array of extra dependencies to install (additive to apm.yml) |
| `isolated` | No | `false` | Ignore apm.yml and clear pre-existing primitive dirs — install only inline dependencies |
| `compile` | No | `false` | Run `apm compile` after install to generate AGENTS.md |
| `pack` | No | `false` | Pack a bundle after install (produces `.tar.gz` by default) |
| `bundle` | No | | Restore from a bundle (local path or glob). Skips APM installation entirely. |
| `target` | No | | Bundle target: `copilot`, `vscode`, `claude`, or `all` (used with `pack: true`) |
| `archive` | No | `true` | Produce `.tar.gz` instead of directory (used with `pack: true`) |

## Outputs

| Output | Description |
|---|---|
| `success` | Whether the action succeeded (`true`/`false`) |
| `primitives-path` | Path where agent primitives were deployed (`.github`) |
| `bundle-path` | Path to the packed bundle (only set in pack mode) |

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
