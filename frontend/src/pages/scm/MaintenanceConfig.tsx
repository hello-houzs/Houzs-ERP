import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../../components/Layout";
import { TabStrip, type TabOption } from "../../components/TabStrip";
import { SofaConfigEditor } from "./maintenance/SofaConfigEditor";
import { FabricTierEditor } from "./maintenance/FabricTierEditor";
import { SpecialAddonsEditor } from "./maintenance/SpecialAddonsEditor";
import { SofaCombosEditor } from "./maintenance/SofaCombosEditor";
import { CategoriesEditor } from "./maintenance/CategoriesEditor";
import { DeliveryFeesEditor } from "./maintenance/DeliveryFeesEditor";
import { FabricLibraryEditor } from "./maintenance/FabricLibraryEditor";
import { StateWarehouseEditor } from "./maintenance/StateWarehouseEditor";
import { PwpEditor } from "./maintenance/PwpEditor";

// Maintenance / configuration hub for the ported 2990's SCM. One page, tabbed,
// each tab a self-contained config editor. The sofa-config / fabric-tier /
// special-addons / combos tabs feed the SO sofa configurator's dropdowns; the
// rest are supporting masters. Active tab lives in the URL (?tab=).
type Tab =
  | "sofa-config"
  | "fabric-tiers"
  | "special-addons"
  | "combos"
  | "categories"
  | "delivery-fees"
  | "fabric-library"
  | "state-warehouse"
  | "pwp";

const TABS: TabOption<Tab>[] = [
  { value: "sofa-config", label: "Sofa Config" },
  { value: "fabric-tiers", label: "Fabric Tiers" },
  { value: "special-addons", label: "Special Add-ons" },
  { value: "combos", label: "Sofa Combos" },
  { value: "categories", label: "Categories" },
  { value: "delivery-fees", label: "Delivery Fees" },
  { value: "fabric-library", label: "Fabric Library" },
  { value: "state-warehouse", label: "State → Warehouse" },
  { value: "pwp", label: "PWP" },
];

export function ScmMaintenanceConfig() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab") as Tab | null;
  const tab: Tab = TABS.some((t) => t.value === raw) ? (raw as Tab) : "sofa-config";

  function setTab(next: Tab) {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set("tab", next);
        return p;
      },
      { replace: true },
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Maintenance"
        description="Configuration the SO sofa builder and pricing read from — option pools, surcharges, combos, and supporting masters."
      />
      <TabStrip value={tab} onChange={setTab} options={TABS} />

      {tab === "sofa-config" && <SofaConfigEditor />}
      {tab === "fabric-tiers" && <FabricTierEditor />}
      {tab === "special-addons" && <SpecialAddonsEditor />}
      {tab === "combos" && <SofaCombosEditor />}
      {tab === "categories" && <CategoriesEditor />}
      {tab === "delivery-fees" && <DeliveryFeesEditor />}
      {tab === "fabric-library" && <FabricLibraryEditor />}
      {tab === "state-warehouse" && <StateWarehouseEditor />}
      {tab === "pwp" && <PwpEditor />}
    </div>
  );
}
