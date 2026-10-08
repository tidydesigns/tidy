/** Preserve result order without starting an unbounded number of requests. */
export async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  limit: number,
  run: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("Concurrency must be a positive integer.");
  const results: Output[] = new Array(values.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (!failed && next < values.length) {
        const index = next++;
        try {
          results[index] = await run(values[index], index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  return results;
}
