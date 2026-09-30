import type { GuestClaim, GuestCreate, GuestIdentity, RecordCreate } from "../shared/contracts";

export interface StoredCredential extends GuestIdentity {
  participant_id: string;
  participant: GuestIdentity["participant"];
  device_secret: string;
}

export interface PendingRegistration {
  kind: "create" | "claim";
  request: GuestCreate | GuestClaim;
}

export interface PendingRecord {
  operation_id: string;
  participant_id: string;
  device_secret: string;
  record: Omit<RecordCreate, "operation_id" | "participant_id">;
  queued_at: string;
}

interface Preference {
  key: string;
  value: string;
}

const DB_VERSION = 1;
const CREDENTIALS = "credentials";
const PREFERENCES = "preferences";
const OUTBOX = "outbox";
const REGISTRATION = "pending-registration";
const openConnections = new Map<string, IDBDatabase>();

function databaseName(apiBase: string): string {
  const url = new URL(apiBase, globalThis.location?.href ?? "http://127.0.0.1/");
  return `favorite-song-survey:${url.origin}${url.pathname}`;
}

function openDatabase(apiBase: string): Promise<IDBDatabase> {
  const name = databaseName(apiBase);
  const existing = openConnections.get(name);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CREDENTIALS)) db.createObjectStore(CREDENTIALS, { keyPath: "participant_id" });
      if (!db.objectStoreNames.contains(PREFERENCES)) db.createObjectStore(PREFERENCES, { keyPath: "key" });
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: "operation_id" });
      if (!db.objectStoreNames.contains(REGISTRATION)) db.createObjectStore(REGISTRATION, { keyPath: "kind" });
    };
    request.onerror = () => reject(request.error ?? new Error("ローカル保存を開けませんでした。"));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        openConnections.delete(name);
      };
      openConnections.set(name, db);
      resolve(db);
    };
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("ローカル保存を読み取れませんでした。"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("ローカル保存を完了できませんでした。"));
    transaction.onerror = () => reject(transaction.error ?? new Error("ローカル保存に失敗しました。"));
  });
}

async function put<T>(apiBase: string, storeName: string, value: T): Promise<void> {
  const db = await openDatabase(apiBase);
  const transaction = db.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(value);
  await transactionDone(transaction);
}

async function get<T>(apiBase: string, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDatabase(apiBase);
  const transaction = db.transaction(storeName, "readonly");
  const value = await requestValue(transaction.objectStore(storeName).get(key)) as T | undefined;
  await transactionDone(transaction);
  return value;
}

export async function saveCredential(apiBase: string, credential: StoredCredential): Promise<void> {
  await put(apiBase, CREDENTIALS, credential);
}

export async function getCredential(apiBase: string, participantId: string): Promise<StoredCredential | undefined> {
  return get(apiBase, CREDENTIALS, participantId);
}

export async function listCredentials(apiBase: string): Promise<StoredCredential[]> {
  const db = await openDatabase(apiBase);
  const transaction = db.transaction(CREDENTIALS, "readonly");
  const values = await requestValue(transaction.objectStore(CREDENTIALS).getAll()) as StoredCredential[];
  await transactionDone(transaction);
  return values;
}

export async function saveSelectedParticipant(apiBase: string, participantId: string): Promise<void> {
  await put(apiBase, PREFERENCES, { key: "selected-participant", value: participantId } satisfies Preference);
}

export async function getSelectedParticipant(apiBase: string): Promise<string | undefined> {
  return (await get<Preference>(apiBase, PREFERENCES, "selected-participant"))?.value;
}

export async function savePendingRegistration(apiBase: string, registration: PendingRegistration): Promise<void> {
  await put(apiBase, REGISTRATION, registration);
}

export async function getPendingRegistration(apiBase: string): Promise<PendingRegistration | undefined> {
  return (await get<PendingRegistration>(apiBase, REGISTRATION, "create"))
    ?? get<PendingRegistration>(apiBase, REGISTRATION, "claim");
}

export async function clearPendingRegistration(apiBase: string): Promise<void> {
  const db = await openDatabase(apiBase);
  const transaction = db.transaction(REGISTRATION, "readwrite");
  transaction.objectStore(REGISTRATION).clear();
  await transactionDone(transaction);
}

export async function enqueueRecord(
  apiBase: string,
  credential: StoredCredential,
  operationId: string,
  record: PendingRecord["record"],
): Promise<PendingRecord> {
  const pending: PendingRecord = {
    operation_id: operationId,
    participant_id: credential.participant_id,
    device_secret: credential.device_secret,
    record: structuredClone(record),
    queued_at: new Date().toISOString(),
  };
  await put(apiBase, OUTBOX, pending);
  return pending;
}

export async function listOutbox(apiBase: string): Promise<PendingRecord[]> {
  const db = await openDatabase(apiBase);
  const transaction = db.transaction(OUTBOX, "readonly");
  const values = await requestValue(transaction.objectStore(OUTBOX).getAll()) as PendingRecord[];
  await transactionDone(transaction);
  return values.sort((a, b) => a.queued_at.localeCompare(b.queued_at));
}

export async function removeFromOutbox(apiBase: string, operationId: string): Promise<void> {
  const db = await openDatabase(apiBase);
  const transaction = db.transaction(OUTBOX, "readwrite");
  transaction.objectStore(OUTBOX).delete(operationId);
  await transactionDone(transaction);
}

export function createSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function newOperationId(): string {
  return crypto.randomUUID();
}

export async function clearLocalState(apiBase: string): Promise<void> {
  const name = databaseName(apiBase);
  openConnections.get(name)?.close();
  openConnections.delete(name);
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("ローカル保存を初期化できませんでした。"));
    request.onblocked = () => reject(new Error("ローカル保存が別の画面で使用中です。"));
  });
}
