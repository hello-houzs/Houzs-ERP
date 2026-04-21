import { Settings2 } from "lucide-react";
import VariantMaintenance from "@/components/VariantMaintenance";
import { PAGE_TITLE, COUNT_BADGE } from "@/lib/ui-tokens";

export default function VariantMaintenancePage() {
  return (
    <div className="min-h-screen bg-[#FAFBFB] p-4 space-y-3">
      <div className="flex items-center gap-2.5">
        <Settings2 className="h-5 w-5 text-[#0F766E] shrink-0" />
        <h1 className={`${PAGE_TITLE} truncate`}>Variant Maintenance</h1>
        <span className={COUNT_BADGE}>Master Data</span>
        <span className="text-[10px] text-gray-400 ml-1">
          Divan heights · Leg heights · Gaps · Specials · Sofa sizes · Fabrics
        </span>
      </div>
      <VariantMaintenance />
    </div>
  );
}
