const database = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open("tidy-designs", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("documents");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
export const designStorage = {
  async read(): Promise<string[]> {
    const db = await database;
    return new Promise((resolve, reject) => {
      const request = db.transaction("documents").objectStore("documents").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },
  async write(id: string, value: string): Promise<void> {
    const db = await database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("documents", "readwrite");
      tx.objectStore("documents").put(value, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
};
