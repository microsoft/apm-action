import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';

/**
 * apm.yml and apm.lock.yaml in the restore target are the project's own
 * metadata, not bundle output: a restore must leave them exactly as it found
 * them (microsoft/apm-action#26). Since APM 0.37, `apm unpack` into an APM
 * project records the files it deploys in that project's apm.lock.yaml
 * (microsoft/apm#4157), which dirties a tracked lockfile and breaks the
 * gh-aw pull_request_target checkout of the PR ref after restore.
 *
 * `apm unpack` still runs against the real project (its admission checks read
 * the project), and the action then puts both files back byte for byte.
 */
const PROJECT_METADATA_FILES = ['apm.yml', 'apm.lock.yaml'] as const;

/** Bytes of each metadata file before restore, or `null` when it was absent. */
export type ProjectMetadataSnapshot = Map<string, Buffer | null>;

export function snapshotProjectMetadata(dir: string): ProjectMetadataSnapshot {
  const snapshot: ProjectMetadataSnapshot = new Map();
  for (const name of PROJECT_METADATA_FILES) {
    const file = path.join(dir, name);
    snapshot.set(name, fs.existsSync(file) ? fs.readFileSync(file) : null);
  }
  return snapshot;
}

/** Put every metadata file back as snapshotted; returns the names it restored. */
export function restoreProjectMetadata(dir: string, snapshot: ProjectMetadataSnapshot): string[] {
  const restored: string[] = [];
  for (const [name, before] of snapshot) {
    const file = path.join(dir, name);
    const exists = fs.existsSync(file);
    if (before === null) {
      if (exists) {
        fs.rmSync(file, { force: true });
        restored.push(name);
      }
    } else if (!exists || !fs.readFileSync(file).equals(before)) {
      fs.writeFileSync(file, before);
      restored.push(name);
    }
  }
  if (restored.length > 0) {
    core.info(
      `Kept project metadata unchanged by the restore: ${restored.join(', ')} `
      + '(bundle restore never modifies apm.yml or apm.lock.yaml; see microsoft/apm-action#26)',
    );
  }
  return restored;
}
