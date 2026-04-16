"use client";

// IndexedDB-backed photo store for event attachments.
// localStorage can't hold images (5MB cap); IndexedDB stores Blobs natively
// which is way more efficient than base64.
//
// Photos are keyed by event A42 and grouped by category.

import { useEffect, useState } from "react";

const DB_NAME = "houzs-photos";
const STORE = "photos";
const VERSION = 1;

export type PhotoCategory =
  | "FLOORPLAN"
  | "3D_RENDER"
  | "BOOTH_SETUP"
  | "EVENT_PHOTO"
  | "OTHER";

export const PHOTO_CATEGORIES: { key: PhotoCategory; label: string; desc: string }[] = [
  { key: "FLOORPLAN",   label: "Floorplan",    desc: "Layout diagrams from the venue / contractor" },
  { key: "3D_RENDER",   label: "3D Renders",   desc: "3D booth visualisations for approval" },
  { key: "BOOTH_SETUP", label: "Booth Setup",  desc: "On-site build photos before opening" },
  { key: "EVENT_PHOTO", label: "Event Photos", desc: "During-event operational & customer photos" },
  { key: "OTHER",       label: "Other",        desc: "Permits, contracts, misc. attachments" },
];

export interface PhotoRecord {
  id: string;
  eventA42: string;
  category: PhotoCategory;
  /** Optional BD-workflow field key (e.g. "floorplan", "agreementApproval") */
  workflowKey?: string;
  filename: string;
  mimeType: string;
  size: number;
  blob: Blob;
  uploadedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
function getDb(): Promise<IDBDatabase> {
  if (typeof window === "undefined") return Promise.reject(new Error("SSR"));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("byEvent", "eventA42");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

const listeners = new Set<() => void>();
function emit() { listeners.forEach((l) => l()); }

export async function addPhoto(
  eventA42: string,
  category: PhotoCategory,
  file: File,
  workflowKey?: string,
): Promise<PhotoRecord> {
  const db = await getDb();
  const record: PhotoRecord = {
    id: crypto.randomUUID(),
    eventA42,
    category,
    workflowKey,
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    blob: file,
    uploadedAt: Date.now(),
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  emit();
  return record;
}

export async function deletePhoto(id: string) {
  const db = await getDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  emit();
}

async function listPhotosForEvent(eventA42: string): Promise<PhotoRecord[]> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const index = tx.objectStore(STORE).index("byEvent");
    const req = index.getAll(eventA42);
    req.onsuccess = () => resolve((req.result as PhotoRecord[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

export function useEventPhotos(a42: string): {
  photos: PhotoRecord[];
  loading: boolean;
} {
  const [photos, setPhotos] = useState<PhotoRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setPhotos([]);
    let cancelled = false;
    const load = () => {
      listPhotosForEvent(a42)
        .then((p) => {
          if (cancelled) return;
          setPhotos(p.sort((a, b) => b.uploadedAt - a.uploadedAt));
          setLoading(false);
        })
        .catch(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    listeners.add(load);
    return () => {
      cancelled = true;
      listeners.delete(load);
    };
  }, [a42]);

  return { photos, loading };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
