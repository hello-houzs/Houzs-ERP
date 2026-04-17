// Event-scoped WhatsApp-style chat panel.
// Embeds in EventDetailPage — auto-creates room when sales assigned,
// auto-archives when event completes.

import { useState, useEffect, useRef, useMemo } from "react";
import { MessageCircle, Send, Users, Archive, ChevronDown, ChevronUp } from "lucide-react";
import {
  useChatMessages, useChatRooms,
  createChatRoom, sendMessage, archiveChatRoom,
  addMemberToChat, removeMemberFromChat,
  getChatRoom, markAsRead,
} from "@/lib/chat-store";
import { useSalesMembers } from "@/lib/sales-store";

interface EventChatProps {
  eventA42: string;
  eventTitle: string;
  assignedSales: string[];
  eventStatus: "NOT STARTED" | "IN PROGRESS" | "COMPLETED";
  currentUserId?: string;
}

// Simple color palette for sender avatars
const AVATAR_COLORS = [
  "#0F766E", "#2563EB", "#7C3AED", "#DB2777",
  "#EA580C", "#CA8A04", "#059669", "#4F46E5",
];
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h + name.charCodeAt(i)) * 31;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const day = d.toLocaleDateString("en-GB", { weekday: "short" });
  return `${day} ${time}`;
}

export function EventChat({
  eventA42,
  eventTitle,
  assignedSales,
  eventStatus,
  currentUserId = "dir-kingsley",
}: EventChatProps) {
  const allRooms = useChatRooms();
  const messages = useChatMessages(eventA42);
  const salesMembers = useSalesMembers();
  const [input, setInput] = useState("");
  const [showMembers, setShowMembers] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const room = useMemo(() => allRooms.find((r) => r.id === eventA42), [allRooms, eventA42]);
  const isArchived = room?.status === "ARCHIVED";

  const currentUserName = useMemo(() => {
    const m = salesMembers.find((s) => s.id === currentUserId);
    return m?.name ?? "You";
  }, [salesMembers, currentUserId]);

  // Resolve member names
  const memberNames = useMemo(() => {
    if (!room) return [];
    return room.memberIds.map((id) => {
      const m = salesMembers.find((s) => s.id === id);
      return m?.name ?? id;
    });
  }, [room, salesMembers]);

  // Auto-create chat room when assigned sales exist but no room yet
  useEffect(() => {
    if (assignedSales.length === 0) return;
    const existing = getChatRoom(eventA42);
    if (!existing) {
      const members = [...new Set([currentUserId, ...assignedSales])];
      createChatRoom(eventA42, eventTitle, members);
    }
  }, [eventA42, eventTitle, assignedSales, currentUserId]);

  // Sync members when assignedSales changes
  useEffect(() => {
    const existing = getChatRoom(eventA42);
    if (!existing || existing.status === "ARCHIVED") return;

    const targetMembers = new Set([currentUserId, ...assignedSales]);
    const currentMembers = new Set(existing.memberIds);

    // Add new members
    for (const id of targetMembers) {
      if (!currentMembers.has(id)) {
        const name = salesMembers.find((s) => s.id === id)?.name ?? id;
        addMemberToChat(eventA42, id, name);
      }
    }

    // Remove members no longer assigned (but keep management)
    for (const id of currentMembers) {
      if (!targetMembers.has(id) && id !== currentUserId) {
        const name = salesMembers.find((s) => s.id === id)?.name ?? id;
        removeMemberFromChat(eventA42, id, name);
      }
    }
  }, [assignedSales, eventA42, currentUserId, salesMembers]);

  // Auto-archive when event completes
  useEffect(() => {
    if (eventStatus === "COMPLETED") {
      const existing = getChatRoom(eventA42);
      if (existing && existing.status === "ACTIVE") {
        archiveChatRoom(eventA42);
      }
    }
  }, [eventStatus, eventA42]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Mark as read when viewing
  useEffect(() => {
    if (room) markAsRead(eventA42);
  }, [messages.length, room, eventA42]);

  function handleSend() {
    const text = input.trim();
    if (!text || isArchived) return;
    sendMessage(eventA42, currentUserId, currentUserName, text);
    setInput("");
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // No sales assigned yet
  if (assignedSales.length === 0 && !room) {
    return (
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center gap-2">
          <MessageCircle className="h-3.5 w-3.5 text-[#0F766E]" />
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E]">Event Chat</h2>
        </div>
        <div className="px-5 py-8 text-center">
          <MessageCircle className="h-8 w-8 text-gray-300 mx-auto mb-2" />
          <p className="text-[12px] text-gray-400">Assign sales members to this event to start chatting</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-3.5 w-3.5 text-[#0F766E]" />
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E]">Event Chat</h2>
          {isArchived && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-gray-100 text-gray-500">
              <Archive className="h-2.5 w-2.5" /> Archived
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowMembers(!showMembers)}
          className="inline-flex items-center gap-1 text-[10px] text-gray-500 hover:text-[#0F766E] transition-colors"
        >
          <Users className="h-3 w-3" />
          {room?.memberIds.length ?? 0} member{(room?.memberIds.length ?? 0) !== 1 ? "s" : ""}
          {showMembers ? <ChevronUp className="h-2.5 w-2.5" /> : <ChevronDown className="h-2.5 w-2.5" />}
        </button>
      </div>

      {/* Members panel (collapsible) */}
      {showMembers && (
        <div className="px-4 py-2 border-b border-[#F0F3F3] bg-[#FAFBFB]">
          <div className="flex flex-wrap gap-1.5">
            {memberNames.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold"
                style={{ backgroundColor: avatarColor(name) + "18", color: avatarColor(name) }}
              >
                <span
                  className="h-3.5 w-3.5 rounded-full flex items-center justify-center text-[8px] text-white font-bold shrink-0"
                  style={{ backgroundColor: avatarColor(name) }}
                >
                  {name.charAt(0)}
                </span>
                {name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Archived banner */}
      {isArchived && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-center">
          <p className="text-[10px] text-amber-700 font-medium">
            This chat has been archived — messages are read-only
          </p>
        </div>
      )}

      {/* Messages area */}
      <div className="max-h-[400px] min-h-[200px] overflow-y-auto px-4 py-3 space-y-1 bg-[#FAFBFB]">
        {messages.length === 0 && (
          <div className="text-center py-8">
            <p className="text-[11px] text-gray-400">No messages yet. Start the conversation!</p>
          </div>
        )}

        {messages.map((msg, i) => {
          const prev = i > 0 ? messages[i - 1] : null;
          const isSystem = msg.type === "SYSTEM";
          const isMe = msg.senderId === currentUserId;
          const showSender = !isSystem && (!prev || prev.senderId !== msg.senderId || prev.type === "SYSTEM");

          if (isSystem) {
            return (
              <div key={msg.id} className="text-center py-1.5">
                <span className="inline-block px-3 py-1 rounded-full bg-gray-100 text-[9px] text-gray-500">
                  {msg.content}
                </span>
              </div>
            );
          }

          return (
            <div key={msg.id} className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}>
              {showSender && (
                <div className={`flex items-center gap-1.5 mb-0.5 ${isMe ? "flex-row-reverse" : ""}`}>
                  <span
                    className="h-5 w-5 rounded-full flex items-center justify-center text-[9px] text-white font-bold shrink-0"
                    style={{ backgroundColor: avatarColor(msg.senderName) }}
                  >
                    {msg.senderName.charAt(0)}
                  </span>
                  <span className="text-[10px] font-semibold" style={{ color: avatarColor(msg.senderName) }}>
                    {msg.senderName}
                  </span>
                </div>
              )}
              <div
                className={`max-w-[75%] px-3 py-1.5 rounded-lg text-[12px] leading-relaxed ${
                  isMe
                    ? "bg-[#0F766E]/10 text-[#0A1F2E] rounded-tr-sm"
                    : "bg-white border border-[#DDE5E5] text-[#0A1F2E] rounded-tl-sm"
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                <p className={`text-[8px] mt-0.5 ${isMe ? "text-[#0F766E]/60" : "text-gray-400"} text-right`}>
                  {formatTime(msg.timestamp)}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      {!isArchived && (
        <div className="px-3 py-2 border-t border-[#DDE5E5] bg-white flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            className="flex-1 h-8 px-3 rounded-md border border-[#DDE5E5] text-[12px] text-[#0A1F2E] placeholder:text-gray-400 outline-none focus:border-[#0F766E] transition-colors"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim()}
            className="h-8 w-8 rounded-md bg-[#0F766E] text-white flex items-center justify-center hover:bg-[#0c5f59] disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
