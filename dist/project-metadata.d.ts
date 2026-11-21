/** Bytes of each metadata file before restore, or `null` when it was absent. */
export type ProjectMetadataSnapshot = Map<string, Buffer | null>;
export declare function snapshotProjectMetadata(dir: string): ProjectMetadataSnapshot;
/** Put every metadata file back as snapshotted; returns the names it restored. */
export declare function restoreProjectMetadata(dir: string, snapshot: ProjectMetadataSnapshot): string[];
