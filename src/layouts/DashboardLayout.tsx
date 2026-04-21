import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar, MobileTopBar } from '@/components/layout/sidebar';

export default function DashboardLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-[#F4F7F7] overflow-x-hidden">
      {/* Mobile top bar — only visible on small screens */}
      <MobileTopBar onOpen={() => setMobileOpen(true)} />

      {/* Sidebar — hidden on mobile unless mobileOpen */}
      <Sidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />

      {/* Main content — no left margin on mobile, md:ml-60 on desktop */}
      <main className="md:ml-60 min-h-screen pt-14 md:pt-0 max-w-full overflow-x-hidden">
        <div className="p-3 md:p-6 max-w-full">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
