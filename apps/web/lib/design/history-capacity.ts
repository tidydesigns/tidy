/** Only this exact database error is safe to translate into a public message. */
export function isHistoryCapacityError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "P0001" &&
    error.message === "file_history_capacity"
  );
}
