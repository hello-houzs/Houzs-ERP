import { Outlet } from 'react-router-dom';
import { Sidebar } from '@/components/layout/sidebar';

export default function DashboardLayout() {
  return (
    <div className="min-h-screen bg-[#F4F7F7]">
      <Sidebar />
      <main className="ml-60 min-h-screen">
        <div className="p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
