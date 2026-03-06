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

### Inline dependencies (no apm.yml needed)

```yaml
- uses: microsoft/apm-action@v1
  with:
    skip-manifest: 'true'
    dependencies: |
      - microsoft/apm-sample-package
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `working-directory` | No | `.` | Working directory for execution |
| `apm-version` | No | `latest` | APM version to install |
| `script` | No | | APM script to run after install |
| `dependencies` | No | | YAML array of extra dependencies to install (additive to apm.yml) |
| `skip-manifest` | No | `false` | Skip apm.yml — install only inline dependencies |
| `compile` | No | `false` | Run `apm compile` after install to generate AGENTS.md |

## Outputs

| Output | Description |
|---|---|
| `success` | Whether the action succeeded (`true`/`false`) |
| `primitives-path` | Path where agent primitives were deployed (`.github`) |

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
