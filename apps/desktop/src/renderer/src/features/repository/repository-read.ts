export function repositoryRead<T>(read: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("This file took too long to open. Try again.")),
      15000,
    );
    read.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
