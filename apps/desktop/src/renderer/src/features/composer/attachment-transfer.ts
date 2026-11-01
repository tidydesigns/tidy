const transfers = new WeakMap<object, Promise<void>>();

export function scheduleAttachmentTransfer<T>(api: object, transfer: () => Promise<T>): Promise<T> {
  const previous = transfers.get(api) ?? Promise.resolve();
  const result = previous.then(transfer);
  const settled = result.then(
    () => {},
    () => {},
  );
  transfers.set(api, settled);
  void settled.then(() => {
    if (transfers.get(api) === settled) transfers.delete(api);
  });
  return result;
}
