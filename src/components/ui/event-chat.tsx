// Event-scoped WhatsApp-style chat panel.
//
// Lifecycle (auto-managed):
//   T-∞ .. T-4 : Planning phase — chat room created with management only,
//                sales members are NOT added yet. Shows countdown banner.
//   T-3 .. T-1 : Activation window — sales members auto-added, milestone
//                system messages posted, full chat unlocked.
//   T-0 .. end : Event running — active chat.
//   > end      : Event completed → chat archived (read-only), history saved
//                to localStorage keyed by eventA42.

import { useState, useEffect, useRef, useMemo } from "react";
import {
  MessageCircle, Send, Users, Archive, ChevronDown, ChevronUp,
  Clock, Rocket, Calendar,
} from "lucide-react";
import {
  useChatMessages, useChatRooms,
  createChatRoom, sendMessage, archiveChatRoom,
  addMemberToChat, removeMemberFromChat,
  getChatRoom, markAsRead,
} from "@/lib/chat-store";
import { useSalesMembers } from "@/lib/sales-store";
import {
  appendSystemMessageIfMissing,
  hasSystemMessage,
} from "@/lib/chat-store";

interface EventChatProps {
  eventA42: string;
  eventTitle: string;
  eventStartDate: string;       // ISO yyyy-mm-dd
  eventEndDate: string;         // ISO yyyy-mm-dd
  assignedSales: string[];
  eventStatus: "NOT STARTED" | "IN PROGRESS" | "COMPLETED";
  pic?: string;                 // PIC name — added to chat automatically
  currentUserId?: string;
}

// Activation window — members auto-added this many days before event start
const ACTIVATION_DAYS_BEFORE = 3;

// Color palette for sender avatars
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

function daysBetween(fromISO: string, toISO: string): number {
  const from = new Date(fromISO);
  const to = new Date(toISO);
  from.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

export function EventChat({
  eventA42,
  eventTitle,
  eventStartDate,
  eventEndDate,
  assignedSales,
  eventStatus,
  pic,
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

  // Compute event lifecycle
  const todayISO = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const daysUntilStart = useMemo(
    () => daysBetween(todayISO, eventStartDate),
    [todayISO, eventStartDate]
  );
  const daysUntilEnd = useMemo(
    () => daysBetween(todayISO, eventEndDate),
    [todayISO, eventEndDate]
  );
  const isWithinActivationWindow = daysUntilStart <= ACTIVATION_DAYS_BEFORE && daysUntilEnd >= 0;
  const isEventRunning = daysUntilStart <= 0 && daysUntilEnd >= 0;
  const isPlanningPhase = daysUntilStart > ACTIVATION_DAYS_BEFORE;

  const currentUserName = useMemo(() => {
    const m = salesMembers.find((s) => s.id === currentUserId);
    return m?.name ?? "You";
  }, [salesMembers, currentUserId]);

  // Resolve PIC user id from name
  const picId = useMemo(() => {
    if (!pic) return null;
    const m = salesMembers.find((s) => s.name.toUpperCase() === pic.toUpperCase());
    return m?.id ?? null;
  }, [pic, salesMembers]);

  // Who gets in the room during planning vs activation
  const planningPhaseMembers = useMemo(() => {
    const ids = [currentUserId];
    if (picId && picId !== currentUserId) ids.push(picId);
    return [...new Set(ids)];
  }, [currentUserId, picId]);

  const fullRosterMembers = useMemo(() => {
    const ids = [currentUserId, ...(picId ? [picId] : []), ...assignedSales];
    return [...new Set(ids)];
  }, [currentUserId, picId, assignedSales]);

  // Resolve member names for display
  const memberNames = useMemo(() => {
    if (!room) return [];
    return room.memberIds.map((id) => {
      const m = salesMembers.find((s) => s.id === id);
      return m?.name ?? id;
    });
  }, [room, salesMembers]);

  // Auto-create chat room when sales assigned
  useEffect(() => {
    if (assignedSales.length === 0) return;
    const existing = getChatRoom(eventA42);
    if (!existing) {
      // Only management + PIC at creation (planning phase)
      createChatRoom(eventA42, eventTitle, planningPhaseMembers);
    }
  }, [eventA42, eventTitle, assignedSales, planningPhaseMembers]);

  // Auto-activation: add sales members when within T-3 window
  useEffect(() => {
    const existing = getChatRoom(eventA42);
    if (!existing || existing.status === "ARCHIVED") return;

    if (isWithinActivationWindow) {
      // Post activation milestone once
      if (!hasSystemMessage(eventA42, "MILESTONE:ACTIVATED")) {
        const daysMsg = daysUntilStart > 0
          ? `Event starting in ${daysUntilStart} day${daysUntilStart === 1 ? "" : "s"} — sales team joining the chat`
          : `Event starting today — sales team joining the chat`;
        appendSystemMessageIfMissing(eventA42, daysMsg, "MILESTONE:ACTIVATED");
      }

      // Add all assigned sales to the group
      const targetSet = new Set(fullRosterMembers);
      const currentSet = new Set(existing.memberIds);
      for (const id of targetSet) {
        if (!currentSet.has(id)) {
          const name = salesMembers.find((s) => s.id === id)?.name ?? id;
          addMemberToChat(eventA42, id, name);
        }
      }
      // Remove any who were un-assigned (except management/PIC)
      for (const id of currentSet) {
        if (!targetSet.has(id)) {
          const name = salesMembers.find((s) => s.id === id)?.name ?? id;
          removeMemberFromChat(eventA42, id, name);
        }
      }
    }
  }, [isWithinActivationWindow, daysUntilStart, eventA42, fullRosterMembers, salesMembers]);

  // Milestone: event started
  useEffect(() => {
    if (isEventRunning && !hasSystemMessage(eventA42, "MILESTONE:STARTED")) {
      appendSystemMessageIfMissing(eventA42, "Event has started", "MILESTONE:STARTED");
    }
  }, [isEventRunning, eventA42]);

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
          {!isArchived && isPlanningPhase && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-100 text-amber-700">
              <Clock className="h-2.5 w-2.5" /> Planning
            </span>
          )}
          {!isArchived && isWithinActivationWindow && !isEventRunning && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-[#0F766E]/10 text-[#0F766E]">
              <Rocket className="h-2.5 w-2.5" /> Activated
            </span>
          )}
          {!isArchived && isEventRunning && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-green-100 text-green-700">
              <Calendar className="h-2.5 w-2.5" /> Live
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
          {isPlanningPhase && assignedSales.length > 0 && (
            <p className="text-[9px] text-amber-600 mt-1.5">
              💡 Sales team will auto-join {ACTIVATION_DAYS_BEFORE} days before event ({daysUntilStart - ACTIVATION_DAYS_BEFORE} more days)
            </p>
          )}
        </div>
      )}

      {/* Lifecycle banner */}
      {!isArchived && isPlanningPhase && assignedSales.length > 0 && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 flex items-center justify-center gap-1.5">
          <Clock className="h-3 w-3 text-amber-600 shrink-0" />
          <p className="text-[10px] text-amber-700 font-medium">
            Planning phase — sales team will auto-join in {daysUntilStart - ACTIVATION_DAYS_BEFORE} day{daysUntilStart - ACTIVATION_DAYS_BEFORE === 1 ? "" : "s"}
            {" "}(T-{ACTIVATION_DAYS_BEFORE}). Only management + PIC for now.
          </p>
        </div>
      )}

      {isArchived && (
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-center gap-1.5">
          <Archive className="h-3 w-3 text-gray-500 shrink-0" />
          <p className="text-[10px] text-gray-600 font-medium">
            Chat archived — event completed · history saved to event record
          </p>
        </div>
      )}

      {/* Messages area */}
      <div className="max-h-[400px] min-h-[240px] overflow-y-auto px-4 py-3 space-y-1 bg-[#FAFBFB]">
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
            // strip milestone prefix like "⟦MILESTONE:KEY⟧ " from display
            const displayContent = msg.content.replace(/^\u27E6MILESTONE:[^\u27E7]+\u27E7\s*/, "");
            return (
              <div key={msg.id} className="text-center py-1.5">
                <span className="inline-block px-3 py-1 rounded-full bg-gray-100 text-[9px] text-gray-500">
                  {displayContent}
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
            placeholder={isPlanningPhase ? "Planning chat (management only)..." : "Type a message..."}
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
