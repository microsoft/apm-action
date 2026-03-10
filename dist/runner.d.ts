/**
 * Run the APM action: install agent primitives.
 *
 * Default behavior (no inputs): reads apm.yml, runs apm install. Done.
 * With `dependencies` input: parses YAML array, installs each as extra deps (additive to apm.yml).
 * With `isolated: true`: clears existing primitives, ignores apm.yml, installs only inline deps.
 * With `compile: true`: runs apm compile after install to generate AGENTS.md.
 * With `script` input: runs an apm script after install.
 * With `pack: true`: runs apm pack after install to produce a bundle.
 * With `bundle` input: restores from a bundle (no APM install needed).
 */
export declare function run(): Promise<void>;
