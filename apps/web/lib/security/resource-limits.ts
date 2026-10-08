/** Hosted resource safety ceilings, independent of paid editing/file allowances. */
export const IMPORT_LIMITS = {
  recordsPerOrganization: 100,
  pendingPerUserPerOrganization: 10,
  chunksPerImport: 32,
  bytesPerImport: 5_000_000,
  bytesPerChunk: 500_000,
  nodesPerImport: 5000,
} as const;

/** Persistent collaboration capacity. Deletions release capacity; rate budgets do not. */
export const COMMENT_LIMITS = {
  threadsPerFile: 500,
  messagesPerFile: 2000,
  messagesPerThread: 200,
  reactionsPerMessage: 1000,
  reactionsPerFile: 10000,
} as const;

/** Retained integration history, separate from deduplicated original-image plan usage. */
export const GITHUB_HISTORY_LIMITS = {
  reviewsPerOrganization: 500,
  reviewsPerFile: 100,
  capturesPerOrganization: 2000,
  capturesPerReview: 200,
  feedbackPerOrganization: 10000,
  feedbackPerReview: 1000,
  snapshotBytes: 5_000_000,
  bytesPerOrganization: 256_000_000,
} as const;

/** Bounded original-image reads used by export and image-context tools. */
export const DESIGN_READ_LIMITS = {
  assetsPerExport: 1000,
  exportDeadlineMs: 30_000,
  exportBytes: 12_000_000,
} as const;

/** Bound cross-workspace image copying; same-workspace ID reuse needs no image I/O. */
export const CLIPBOARD_LIMITS = {
  assetsPerCopy: 100,
  bytesPerImage: 2_000_000,
  bytesPerCopy: 16_000_000,
  copyDeadlineMs: 30_000,
} as const;

/** Hosted image attempts; accounts span workspaces and workspaces span actors. */
export const IMAGE_OPERATION_LIMITS = {
  read: { accountMinute: 240, accountHour: 6000, workspaceMinute: 1200, workspaceHour: 30000 },
  thumbnail: { accountMinute: 60, accountHour: 1000, workspaceMinute: 300, workspaceHour: 5000 },
} as const;

/** Single private images cover supported 2 MB/2 MiB originals with a small margin.
 * Admission also bounds simultaneous buffering/transform work in one isolate. */
export const IMAGE_READ_LIMITS = {
  bytes: 3_000_000,
  deadlineMs: 10_000,
  concurrentReads: 4,
} as const;

/** Browser copies are atomic, bounded batches, independent of paid file allowances. */
export const FILE_MANAGEMENT_LIMITS = {
  filesPerCopy: 25,
  filesPerFolderRemoval: 1000,
  documentBytesPerFile: 5_000_000,
  documentBytesPerCopy: 16_000_000,
  nodesPerCopy: 10_000,
  legacyShapesPerCopy: 10_000,
  accountMinute: 20,
  accountHour: 200,
  workspaceMinute: 100,
  workspaceHour: 1000,
} as const;

/** Personal provider accounts and durable mutation receipts are bounded independently of plans. */
export const LINEAR_LIMITS = {
  accountsPerUser: 50,
  connectionsPerOrganization: 100,
  statesPerUser: 100,
  statesPerUserOrganization: 20,
  operationsPerConnection: 1000,
  operationsPerOrganization: 5000,
  attempts: {
    read: { accountMinute: 60, accountHour: 600, workspaceMinute: 300, workspaceHour: 3000 },
    write: { accountMinute: 20, accountHour: 200, workspaceMinute: 100, workspaceHour: 1000 },
    oauth: { accountMinute: 10, accountHour: 100, workspaceMinute: 30, workspaceHour: 300 },
  },
} as const;
