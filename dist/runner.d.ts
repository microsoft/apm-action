/**
 * Run the APM action: install + compile agent primitives.
 *
 * Default behavior (no inputs): reads apm.yml, installs deps, compiles AGENTS.md. Done.
 * With `dependencies` input: generates a temporary apm.yml from the inline list.
 * With `isolated: true`: installs to /tmp/apm-isolated instead of repo .github/.
 * With `script` input: runs an apm script after install+compile.
 */
export declare function run(): Promise<void>;
