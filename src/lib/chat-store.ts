// Event-scoped chat store — localStorage-backed with subscriber pattern.
// Each event (identified by a42) gets a ChatRoom; messages belong to a room.
// Reactive via useSyncExternalStore, same pattern as events-store / sales-store.

import { useSyncExternalStore } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;           // unique ID (timestamp + random)
  chatId: string;       // = event a42 (the chat room is per-event)
  senderId: string;     // sales member ID (from sales-store)
  senderName: string;   // denormalized for display
  content: string;      // message text
  timestamp: string;    // ISO datetime
  type: "TEXT" | "SYSTEM";  // SYSTEM = auto-generated (e.g. "Chat created", "Event started")
}

export interface ChatRoom {
  id: string;           // = event a42
  eventA42: string;     // same as id
  title: string;        // event calendar title
  memberIds: string[];  // sales member IDs who are in this chat
  status: "ACTIVE" | "ARCHIVED";
  createdAt: string;    // ISO datetime
  archivedAt?: string;  // ISO datetime when archived
}

// ─── localStorage keys ──────────────────────────────────────────────────────

const ROOMS_KEY = "houzs-chat-rooms-v1";
const MESSAGES_KEY = "houzs-chat-messages-v1";
const LASTREAD_KEY = "houzs-chat-lastread-v1";

// ─── Helpers ────────────────────────────────────────────────────────────────

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

// ─── Subscriber registry (shared by rooms + messages) ───────────────────────

const listeners = new Set<() => void>();
let cachedRooms: ChatRoom[] | null = null;
let cachedMessages: ChatMessage[] | null = null;

function emit() {
  cachedRooms = null;
  cachedMessages = null;
  listeners.forEach((l) => l());
}

// ─── Raw read/write ─────────────────────────────────────────────────────────

function readRooms(): ChatRoom[] {
  if (typeof window === "undefined") return [];
  return safeParse<ChatRoom[]>(localStorage.getItem(ROOMS_KEY), []);
}

function writeRooms(rooms: ChatRoom[]) {
  localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms));
  emit();
}

function readMessages(): ChatMessage[] {
  if (typeof window === "undefined") return [];
  return safeParse<ChatMessage[]>(localStorage.getItem(MESSAGES_KEY), []);
}

function writeMessages(msgs: ChatMessage[]) {
  localStorage.setItem(MESSAGES_KEY, JSON.stringify(msgs));
  emit();
}

function readLastRead(): Record<string, string> {
  if (typeof window === "undefined") return {};
  return safeParse<Record<string, string>>(localStorage.getItem(LASTREAD_KEY), {});
}

function writeLastRead(map: Record<string, string>) {
  localStorage.setItem(LASTREAD_KEY, JSON.stringify(map));
  emit();
}

// ─── Subscribe / snapshots ──────────────────────────────────────────────────

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  // Listen for cross-tab localStorage changes
  const onStorage = () => { cachedRooms = null; cachedMessages = null; cb(); };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

function getRoomsSnapshot(): ChatRoom[] {
  if (!cachedRooms) cachedRooms = readRooms();
  return cachedRooms;
}

function getMessagesSnapshot(): ChatMessage[] {
  if (!cachedMessages) cachedMessages = readMessages();
  return cachedMessages;
}

const EMPTY_ROOMS: ChatRoom[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];

// ─── Internal: append a system message ──────────────────────────────────────

function appendSystemMessage(chatId: string, content: string): ChatMessage {
  const msg: ChatMessage = {
    id: uid(),
    chatId,
    senderId: "SYSTEM",
    senderName: "System",
    content,
    timestamp: new Date().toISOString(),
    type: "SYSTEM",
  };
  const all = readMessages();
  all.push(msg);
  writeMessages(all);
  return msg;
}

// ─── Hooks (reactive via useSyncExternalStore) ──────────────────────────────

/** All chat rooms (reactive). */
export function useChatRooms(): ChatRoom[] {
  return useSyncExternalStore(subscribe, getRoomsSnapshot, () => EMPTY_ROOMS);
}

/** Messages for a specific chat, sorted by timestamp ascending (reactive). */
export function useChatMessages(chatId: string): ChatMessage[] {
  const all = useSyncExternalStore(subscribe, getMessagesSnapshot, () => EMPTY_MESSAGES);
  return all
    .filter((m) => m.chatId === chatId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Unread message count for a chat room (reactive).
 *  Based on last-read timestamp stored in localStorage. */
export function useUnreadCount(chatId: string): number {
  // Subscribe to store changes so this re-evaluates reactively
  const allMessages = useSyncExternalStore(subscribe, getMessagesSnapshot, () => EMPTY_MESSAGES);
  const lastReadMap = readLastRead();
  const lastReadTs = lastReadMap[chatId];

  return allMessages.filter((m) => {
    if (m.chatId !== chatId) return false;
    if (!lastReadTs) return true; // never read → all are unread
    return m.timestamp > lastReadTs;
  }).length;
}

// ─── Mutations ──────────────────────────────────────────────────────────────

/** Create a chat room for an event. If one already exists for this a42, return it. */
export function createChatRoom(
  eventA42: string,
  title: string,
  memberIds: string[],
): ChatRoom {
  const rooms = readRooms();
  const existing = rooms.find((r) => r.eventA42 === eventA42);
  if (existing) return existing;

  const room: ChatRoom = {
    id: eventA42,
    eventA42,
    title,
    memberIds,
    status: "ACTIVE",
    createdAt: new Date().toISOString(),
  };
  rooms.push(room);
  writeRooms(rooms);

  // System message
  appendSystemMessage(eventA42, `Chat created for ${title}`);

  return room;
}

/** Archive a chat room (event ended). */
export function archiveChatRoom(eventA42: string): void {
  const rooms = readRooms();
  const idx = rooms.findIndex((r) => r.eventA42 === eventA42);
  if (idx < 0) return;

  rooms[idx] = {
    ...rooms[idx],
    status: "ARCHIVED",
    archivedAt: new Date().toISOString(),
  };
  writeRooms(rooms);

  appendSystemMessage(eventA42, "Event ended \u2014 chat archived");
}

/** Send a text message to a chat room. */
export function sendMessage(
  chatId: string,
  senderId: string,
  senderName: string,
  content: string,
): ChatMessage {
  const msg: ChatMessage = {
    id: uid(),
    chatId,
    senderId,
    senderName,
    content,
    timestamp: new Date().toISOString(),
    type: "TEXT",
  };
  const all = readMessages();
  all.push(msg);
  writeMessages(all);
  return msg;
}

/** Add a member to a chat room. */
export function addMemberToChat(chatId: string, memberId: string, displayName?: string): void {
  const rooms = readRooms();
  const idx = rooms.findIndex((r) => r.id === chatId);
  if (idx < 0) return;
  if (rooms[idx].memberIds.includes(memberId)) return; // already a member

  rooms[idx] = {
    ...rooms[idx],
    memberIds: [...rooms[idx].memberIds, memberId],
  };
  writeRooms(rooms);

  appendSystemMessage(chatId, `${displayName ?? memberId} joined the chat`);
}

/** Remove a member from a chat room. */
export function removeMemberFromChat(chatId: string, memberId: string, displayName?: string): void {
  const rooms = readRooms();
  const idx = rooms.findIndex((r) => r.id === chatId);
  if (idx < 0) return;
  if (!rooms[idx].memberIds.includes(memberId)) return; // not a member

  rooms[idx] = {
    ...rooms[idx],
    memberIds: rooms[idx].memberIds.filter((id) => id !== memberId),
  };
  writeRooms(rooms);

  appendSystemMessage(chatId, `${displayName ?? memberId} left the chat`);
}

/** Mark all messages in a chat as read (updates last-read timestamp to now). */
export function markAsRead(chatId: string): void {
  const map = readLastRead();
  map[chatId] = new Date().toISOString();
  writeLastRead(map);
}

/** Delete a chat room and all its messages (for cleanup). */
export function deleteChatRoom(eventA42: string): void {
  const rooms = readRooms().filter((r) => r.eventA42 !== eventA42);
  writeRooms(rooms);

  const msgs = readMessages().filter((m) => m.chatId !== eventA42);
  writeMessages(msgs);

  // Clean up last-read entry
  const lastRead = readLastRead();
  delete lastRead[eventA42];
  writeLastRead(lastRead);
}

// ─── Helpers (non-reactive) ─────────────────────────────────────────────────

/** Find a chat room by event a42 (non-reactive, point-in-time read). */
export function getChatRoom(eventA42: string): ChatRoom | undefined {
  return readRooms().find((r) => r.eventA42 === eventA42);
}

/** Get all active (non-archived) chat rooms (non-reactive, point-in-time read). */
export function getActiveChatRooms(): ChatRoom[] {
  return readRooms().filter((r) => r.status === "ACTIVE");
}
