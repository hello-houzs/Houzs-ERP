// Top-right user menu — avatar + name + position + logout.
// Admin sees Admin → Users / Audit Log shortcuts.

import { useRef, useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LogOut, UserCog, KeyRound, Users as UsersIcon, ScrollText, ChevronDown } from "lucide-react";
import { useAuth, logout } from "@/lib/auth-store";

export function UserMenu() {
  const { user, isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  if (!user) return null;

  const initials = user.name.split(" ").map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

  async function handleLogout() {
    await logout();
    nav("/login", { replace: true });
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full h-7 pl-1 pr-2 bg-white border border-[#E5E7EB] hover:border-[#0F766E] text-[11px]"
      >
        <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-[#0F766E] text-white text-[9px] font-bold">
          {initials || "?"}
        </span>
        <span className="font-semibold text-[#0A1F2E] max-w-[120px] truncate">{user.name}</span>
        <ChevronDown className="h-3 w-3 text-gray-400" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 rounded-lg border border-[#E5E7EB] bg-white shadow-lg overflow-hidden z-50">
          <div className="px-3 py-3 border-b border-[#F0F1F3]">
            <div className="text-[12px] font-bold text-[#0A1F2E]">{user.name}</div>
            <div className="text-[10px] text-gray-500 truncate">{user.email}</div>
            <div className="text-[10px] text-[#0F766E] mt-0.5 font-semibold">{user.position}</div>
          </div>
          {isAdmin && (
            <div className="py-1 border-b border-[#F0F1F3]">
              <MenuItem icon={<UsersIcon className="h-3.5 w-3.5" />} label="Users" onClick={() => { setOpen(false); nav("/admin/users"); }} />
              <MenuItem icon={<ScrollText className="h-3.5 w-3.5" />} label="Audit Log" onClick={() => { setOpen(false); nav("/admin/audit-log"); }} />
            </div>
          )}
          <div className="py-1">
            <Link to="/change-password" onClick={() => setOpen(false)}>
              <MenuRow icon={<KeyRound className="h-3.5 w-3.5" />} label="Change password" />
            </Link>
            <MenuItem icon={<LogOut className="h-3.5 w-3.5" />} label="Sign out" onClick={handleLogout} />
          </div>
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-gray-700 hover:bg-[#F9FAFB]">
      {icon}<span>{label}</span>
    </button>
  );
}

function MenuRow({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-gray-700 hover:bg-[#F9FAFB] cursor-pointer">
      {icon}<span>{label}</span>
    </div>
  );
}
