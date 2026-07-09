import { IconButton } from "autocount-sync-frontend";
import { Pencil, Trash2, Printer, Download, RefreshCw } from "lucide-react";

// Square 32px icon-only button — table row tools, panel header actions.

export const ToolbarRow = () => (
  <div className="flex items-center gap-1.5">
    <IconButton icon={<Pencil size={14} />} title="Edit" />
    <IconButton icon={<Printer size={14} />} title="Print" />
    <IconButton icon={<Download size={14} />} title="Export" />
    <IconButton icon={<RefreshCw size={14} />} title="Refresh" />
  </div>
);

export const DangerAndDisabled = () => (
  <div className="flex items-center gap-1.5">
    <IconButton
      icon={<Trash2 size={14} />}
      title="Delete"
      className="hover:border-err/50 hover:bg-err/5 hover:text-err"
    />
    <IconButton icon={<Pencil size={14} />} disabled className="opacity-50" title="Locked" />
  </div>
);

export const InPanelHeader = () => (
  <div className="flex w-72 items-center justify-between rounded-lg border border-border bg-surface px-3 py-2 shadow-stone">
    <span className="text-[12px] font-semibold text-ink">Delivery photos</span>
    <div className="flex gap-1.5">
      <IconButton icon={<Download size={14} />} title="Download all" />
      <IconButton icon={<RefreshCw size={14} />} title="Reload" />
    </div>
  </div>
);
