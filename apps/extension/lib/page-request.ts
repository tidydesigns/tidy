/** A frozen/discarded page must not leave the worker's import job busy forever. */
export async function pageRequest<T>(request: Promise<T>, timeoutMs = 25000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("The source page stopped responding. Reopen the extension and try again."),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
