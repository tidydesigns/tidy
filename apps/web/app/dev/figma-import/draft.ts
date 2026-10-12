import { documentAssetIds, parseDesignDocument, type DesignDocument } from "@bella/design/document";
export type LocalDraft = { id: string; name: string; document: DesignDocument };
const databaseName = "tidy-figma-prototype";
let queue = Promise.resolve();
const blobs = new Map<string, Promise<Blob>>();
function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("draft");
      request.result.createObjectStore("assets");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function completed(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () =>
      reject(transaction.error ?? new Error("Local storage is unavailable."));
  });
}
export async function readLocalDraft() {
  const db = await database();
  try {
    const transaction = db.transaction(["draft", "assets"], "readonly");
    const done = completed(transaction);
    const draftRequest = transaction.objectStore("draft").get("current");
    const assetsRequest = transaction.objectStore("assets").getAll();
    const keysRequest = transaction.objectStore("assets").getAllKeys();
    await done;
    const draft = draftRequest.result as LocalDraft | undefined;
    if (!draft) return null;
    draft.document = parseDesignDocument(draft.document);
    const assets = new Map<string, Blob>();
    keysRequest.result.forEach((id, index) =>
      assets.set(String(id), assetsRequest.result[index] as Blob),
    );
    return { draft, assets };
  } finally {
    db.close();
  }
}
/** Capture blob data immediately, then serialize commits so a slow old edit
 * cannot overwrite a newer file or undo. Image bytes are written only once. */
export function writeLocalDraft(draft: LocalDraft, urls: Record<string, string>) {
  const assetIds = documentAssetIds(draft.document);
  const pending = assetIds.map((id) => {
    if (!blobs.has(id)) {
      const url = urls[id];
      if (!url?.startsWith("blob:"))
        return Promise.reject(new Error("An imported image is unavailable."));
      blobs.set(
        id,
        fetch(url).then((response) => response.blob()),
      );
    }
    return blobs.get(id)!.then((blob) => ({ id, blob }));
  });
  const assets = Promise.all(pending);
  // Handle a rejected fetch immediately, even while an earlier commit is in flight.
  void assets.catch(() => {});
  const result = queue.then(async () => {
    const values = await assets;
    const db = await database();
    try {
      const transaction = db.transaction(["draft", "assets"], "readwrite");
      const done = completed(transaction);
      const store = transaction.objectStore("assets");
      const existing = store.getAllKeys();
      existing.onsuccess = () => {
        const retained = new Set(assetIds);
        const known = new Set(existing.result.map(String));
        for (const id of existing.result) if (!retained.has(String(id))) store.delete(id);
        for (const value of values) if (!known.has(value.id)) store.put(value.blob, value.id);
      };
      transaction.objectStore("draft").put(draft, "current");
      await done;
      // Retain only current data; URL-backed assets can be fetched again on redo.
      for (const id of blobs.keys()) if (!assetIds.includes(id)) blobs.delete(id);
    } finally {
      db.close();
    }
  });
  queue = result.catch(() => {});
  return result;
}
