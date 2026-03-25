export type OfflineDbStores = "keys" | "ops" | "snapshots" | "meta";

let dbPromise: Promise<IDBDatabase> | null = null;

export function openOfflineDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open("openslin_offline_v1", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("keys")) db.createObjectStore("keys", { keyPath: "keyId" });
      if (!db.objectStoreNames.contains("ops")) db.createObjectStore("ops", { keyPath: "opId" });
      if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots", { keyPath: "key" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("idb_open_failed"));
  });
  return dbPromise;
}

export async function idbGet<T>(db: IDBDatabase, store: OfflineDbStores, key: IDBValidKey) {
  return new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error ?? new Error("idb_get_failed"));
  });
}

export async function idbPut(db: IDBDatabase, store: OfflineDbStores, value: unknown) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).put(value as any);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("idb_put_failed"));
  });
}

export async function idbDelete(db: IDBDatabase, store: OfflineDbStores, key: IDBValidKey) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("idb_delete_failed"));
  });
}

export async function idbGetAll<T>(db: IDBDatabase, store: OfflineDbStores) {
  return new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve((req.result as T[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error("idb_get_all_failed"));
  });
}

