export function repositoryRead<T>(read: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error("Reading repository files timed out. Check the connection, then retry.")),
      15000,
    );
    read.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
