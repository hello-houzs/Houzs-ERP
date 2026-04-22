import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Check, AlertCircle, Save, Pencil } from "lucide-react";
import {
  CARD,
  BTN_PRIMARY,
  BTN_SECONDARY,
  FIELD_INPUT,
  FIELD_LABEL,
  FIELD_SELECT,
  FILTER_SELECT,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_HEAD_CELL,
  TABLE_BODY,
  TABLE_CELL,
} from "@/lib/ui-tokens";

// ─── Types ────────────────────────────────────────────────────────────────────

type MaintenanceListKey =
  | "divanHeights"
  | "legHeights"
  | "totalHeights"
  | "gaps"
  | "specials"
  | "sofaLegHeights"
  | "sofaSpecials"
  | "sofaSizes";

type PricedOption = { value: string; priceSen: number };

type MaintenanceConfig = {
  divanHeights: PricedOption[];
  legHeights: PricedOption[];
  totalHeights: PricedOption[];
  gaps: string[];
  specials: PricedOption[];
  sofaLegHeights: PricedOption[];
  sofaSpecials: PricedOption[];
  sofaSizes: string[];
};

type MaintenanceTab = MaintenanceListKey | "fabrics";

type FabricTrackingItem = {
  id: string;
  fabricCode: string;
  priceTier: "PRICE_1" | "PRICE_2";
  price: number;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const MAINTENANCE_STORAGE_KEY = "houzs-variants-config";
const FABRIC_STORAGE_KEY = "houzs-fabric-tracking";

const DEFAULT_MAINTENANCE_CONFIG: MaintenanceConfig = {
  divanHeights: [
    { value: '4"', priceSen: 0 },
    { value: '5"', priceSen: 0 },
    { value: '6"', priceSen: 0 },
    { value: '8"', priceSen: 0 },
    { value: '10"', priceSen: 5000 },
    { value: '11"', priceSen: 12000 },
    { value: '12"', priceSen: 12000 },
    { value: '13"', priceSen: 14000 },
    { value: '14"', priceSen: 14000 },
    { value: '16"', priceSen: 15000 },
  ],
  legHeights: [
    { value: "No Leg", priceSen: 0 },
    { value: '1"', priceSen: 0 },
    { value: '2"', priceSen: 0 },
    { value: '4"', priceSen: 0 },
    { value: '6"', priceSen: 0 },
    { value: '7"', priceSen: 16000 },
  ],
  totalHeights: [
    { value: '10"', priceSen: 0 },
    { value: '12"', priceSen: 0 },
    { value: '14"', priceSen: 0 },
    { value: '16"', priceSen: 5000 },
    { value: '18"', priceSen: 5000 },
    { value: '20"', priceSen: 10000 },
    { value: '22"', priceSen: 12000 },
    { value: '24"', priceSen: 14000 },
    { value: '26"', priceSen: 15000 },
    { value: '28"', priceSen: 16000 },
  ],
  gaps: ['4"', '5"', '6"', '7"', '8"', '9"', '10"'],
  specials: [
    { value: "HB Fully Cover", priceSen: 5000 },
    { value: "Divan Top Fully Cover", priceSen: 5000 },
    { value: "Divan Full Cover", priceSen: 8000 },
    { value: "Left Drawer", priceSen: 15000 },
    { value: "Right Drawer", priceSen: 15000 },
    { value: "Front Drawer", priceSen: 12000 },
    { value: "HB Straight", priceSen: 0 },
    { value: "Divan Top(W)", priceSen: 0 },
    { value: "1 Piece Divan", priceSen: 25000 },
    { value: "Divan Curve", priceSen: 5000 },
    { value: "No Side Panel", priceSen: 4000 },
    { value: "Headboard Only", priceSen: 0 },
    { value: "Nylon Fabric", priceSen: 0 },
    { value: "5537 Backrest", priceSen: 0 },
    { value: 'Add 1" Infront L', priceSen: 0 },
    { value: "Separate Backrest Packing", priceSen: 0 },
    { value: "Divan A11", priceSen: 0 },
    { value: 'Seat Add On 4"', priceSen: 0 },
  ],
  sofaLegHeights: [
    { value: "No Leg", priceSen: 0 },
    { value: '4"', priceSen: 0 },
    { value: '6"', priceSen: 0 },
  ],
  sofaSpecials: [
    { value: "Nylon Fabric", priceSen: 0 },
    { value: "5537 Backrest", priceSen: 0 },
    { value: "Separate Backrest Packing", priceSen: 0 },
  ],
  sofaSizes: ["24", "26", "28", "30", "32", "35"],
};

const MAINTENANCE_TABS: {
  key: MaintenanceTab;
  label: string;
  description: string;
  priced?: boolean;
  section?: string;
}[] = [
  { key: "divanHeights", label: "Divan Heights", description: "Bedframe divan height options with surcharge pricing", priced: true, section: "Bedframe" },
  { key: "totalHeights", label: "Total Heights", description: "Total height (Divan + Gap + Leg) surcharge pricing", priced: true, section: "Bedframe" },
  { key: "gaps", label: "Gaps", description: "Bedframe gap height options (inches)", section: "Bedframe" },
  { key: "legHeights", label: "Leg Heights", description: "Bedframe leg height options with surcharge pricing", priced: true, section: "Bedframe" },
  { key: "specials", label: "Specials", description: "Bedframe special order options with surcharge pricing", priced: true, section: "Bedframe" },
  { key: "sofaSizes", label: "Sizes", description: "Available sofa seat height sizes (inches)", section: "Sofa" },
  { key: "sofaLegHeights", label: "Leg Heights", description: "Sofa leg height options with surcharge pricing", priced: true, section: "Sofa" },
  { key: "sofaSpecials", label: "Specials", description: "Sofa special order options with surcharge pricing", priced: true, section: "Sofa" },
  { key: "fabrics", label: "Fabrics", description: "Fabric price tier assignment — determines Price 1 or Price 2 for bedframe pricing", section: "Common" },
];

// ─── Persistence helpers ─────────────────────────────────────────────────────

function loadMaintenanceConfig(): MaintenanceConfig {
  if (typeof window === "undefined") return DEFAULT_MAINTENANCE_CONFIG;
  try {
    const raw = localStorage.getItem(MAINTENANCE_STORAGE_KEY);
    if (!raw) return DEFAULT_MAINTENANCE_CONFIG;
    const parsed = JSON.parse(raw);

    function ensurePriced(val: unknown, defaults: PricedOption[]): PricedOption[] {
      if (!Array.isArray(val)) return defaults;
      if (val.length === 0) return defaults;
      if (typeof val[0] === "string") {
        return (val as string[]).map((v) => {
          const def = defaults.find((d) => d.value === v);
          return { value: v, priceSen: def?.priceSen ?? 0 };
        });
      }
      return val as PricedOption[];
    }

    function ensureStrings(val: unknown, defaults: string[]): string[] {
      if (!Array.isArray(val)) return defaults;
      return val as string[];
    }

    return {
      divanHeights: ensurePriced(parsed.divanHeights, DEFAULT_MAINTENANCE_CONFIG.divanHeights),
      legHeights: ensurePriced(parsed.legHeights, DEFAULT_MAINTENANCE_CONFIG.legHeights),
      totalHeights: ensurePriced(parsed.totalHeights, DEFAULT_MAINTENANCE_CONFIG.totalHeights),
      gaps: ensureStrings(parsed.gaps, DEFAULT_MAINTENANCE_CONFIG.gaps),
      specials: ensurePriced(parsed.specials, DEFAULT_MAINTENANCE_CONFIG.specials),
      sofaLegHeights: ensurePriced(parsed.sofaLegHeights, DEFAULT_MAINTENANCE_CONFIG.sofaLegHeights),
      sofaSpecials: ensurePriced(parsed.sofaSpecials, DEFAULT_MAINTENANCE_CONFIG.sofaSpecials),
      sofaSizes: ensureStrings(parsed.sofaSizes, DEFAULT_MAINTENANCE_CONFIG.sofaSizes),
    };
  } catch {
    return DEFAULT_MAINTENANCE_CONFIG;
  }
}

function saveMaintenanceConfig(cfg: MaintenanceConfig) {
  if (typeof window === "undefined") return;
  // Cache locally first so UI survives a network blip
  try {
    const raw = localStorage.getItem(MAINTENANCE_STORAGE_KEY);
    let existing: Record<string, unknown> = {};
    if (raw) {
      try { existing = JSON.parse(raw); } catch { /* ignore */ }
    }
    localStorage.setItem(MAINTENANCE_STORAGE_KEY, JSON.stringify({ ...existing, ...cfg }));
  } catch { /* ignore */ }
  // Then push the whole config blob up to D1
  fetch("/api/variants", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg),
  }).catch((e) => console.warn("[variants] PUT failed:", e));
}

async function fetchMaintenanceConfigFromApi(): Promise<MaintenanceConfig | null> {
  try {
    const r = await fetch("/api/variants");
    if (!r.ok) return null;
    return (await r.json()) as MaintenanceConfig | null;
  } catch { return null; }
}

function loadFabrics(): FabricTrackingItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(FABRIC_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as FabricTrackingItem[];
  } catch {
    return [];
  }
}

function saveFabrics(list: FabricTrackingItem[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(FABRIC_STORAGE_KEY, JSON.stringify(list));
  } catch { /* ignore */ }
}

async function fetchFabricsFromApi(): Promise<FabricTrackingItem[] | null> {
  try {
    const r = await fetch("/api/fabrics");
    if (!r.ok) return null;
    return (await r.json()) as FabricTrackingItem[];
  } catch { return null; }
}

function pushFabricToApi(f: FabricTrackingItem) {
  // Upsert single fabric; server uses ON CONFLICT(fabric_code) DO UPDATE
  fetch("/api/fabrics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(f),
  }).catch((e) => console.warn("[fabrics] POST failed:", e));
}

function deleteFabricFromApi(id: string) {
  fetch(`/api/fabrics/${encodeURIComponent(id)}`, { method: "DELETE" })
    .catch((e) => console.warn("[fabrics] DELETE failed:", e));
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function VariantMaintenance() {
  const [config, setConfig] = useState<MaintenanceConfig>(DEFAULT_MAINTENANCE_CONFIG);
  const [savedSnapshot, setSavedSnapshot] = useState<string>("");
  const [tab, setTab] = useState<MaintenanceTab>("divanHeights");
  const [newValue, setNewValue] = useState("");
  const [newPriceSen, setNewPriceSen] = useState(0);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const [toastMsg, setToastMsg] = useState("Saved");

  // Fabrics (localStorage-backed)
  const [fabricsList, setFabricsList] = useState<FabricTrackingItem[]>([]);
  const [fabricSearch, setFabricSearch] = useState("");
  const [newFabricCode, setNewFabricCode] = useState("");
  const [newFabricTier, setNewFabricTier] = useState<"PRICE_1" | "PRICE_2">("PRICE_2");
  const [newFabricPrice, setNewFabricPrice] = useState<string>("");

  useEffect(() => {
    // Paint from localStorage immediately…
    const loaded = loadMaintenanceConfig();
    setConfig(loaded);
    setSavedSnapshot(JSON.stringify(loaded));
    setFabricsList(loadFabrics());
    // …then replace with server truth when it arrives
    let mounted = true;
    fetchMaintenanceConfigFromApi().then((cfg) => {
      if (!mounted || !cfg) return;
      setConfig(cfg);
      setSavedSnapshot(JSON.stringify(cfg));
      try { localStorage.setItem(MAINTENANCE_STORAGE_KEY, JSON.stringify(cfg)); } catch { /* quota */ }
    });
    fetchFabricsFromApi().then((list) => {
      if (!mounted || !list) return;
      setFabricsList(list);
      try { localStorage.setItem(FABRIC_STORAGE_KEY, JSON.stringify(list)); } catch { /* quota */ }
    });
    return () => { mounted = false; };
  }, []);

  // Auto-save config to localStorage whenever it changes (debounced).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const snap = JSON.stringify(config);
    if (snap === savedSnapshot) return;
    const t = setTimeout(() => {
      saveMaintenanceConfig(config);
      setSavedSnapshot(snap);
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  // Auto-save fabrics list on any change
  useEffect(() => {
    saveFabrics(fabricsList);
  }, [fabricsList]);

  function showToast(msg: string) {
    setToastMsg(msg);
    setToastVisible(true);
    setTimeout(() => setToastVisible(false), 2000);
  }

  const isDirty = useMemo(() => JSON.stringify(config) !== savedSnapshot, [config, savedSnapshot]);

  const isFabricsTab = tab === "fabrics";
  const meta = MAINTENANCE_TABS.find((t) => t.key === tab)!;
  const isPricedTab = !isFabricsTab && (meta.priced ?? false);
  const currentStringList =
    !isFabricsTab && !isPricedTab ? (config[tab as MaintenanceListKey] as string[]) : [];
  const currentPricedList =
    !isFabricsTab && isPricedTab ? (config[tab as MaintenanceListKey] as PricedOption[]) : [];

  function addEntry() {
    if (isFabricsTab) return;
    const k = tab as MaintenanceListKey;
    const v = newValue.trim();
    if (!v) return;
    if (isPricedTab) {
      const list = config[k] as PricedOption[];
      if (list.some((o) => o.value === v)) {
        setNewValue("");
        return;
      }
      setConfig((prev) => ({
        ...prev,
        [k]: [...(prev[k] as PricedOption[]), { value: v, priceSen: newPriceSen }],
      }));
    } else {
      const list = config[k] as string[];
      if (list.includes(v)) {
        setNewValue("");
        return;
      }
      setConfig((prev) => ({ ...prev, [k]: [...(prev[k] as string[]), v] }));
    }
    setNewValue("");
    setNewPriceSen(0);
  }

  function removeEntry(idx: number) {
    if (isFabricsTab) return;
    const k = tab as MaintenanceListKey;
    setConfig((prev) => ({
      ...prev,
      [k]: (prev[k] as (string | PricedOption)[]).filter((_, i) => i !== idx),
    }));
  }

  function updatePrice(idx: number, priceSen: number) {
    if (isFabricsTab) return;
    const k = tab as MaintenanceListKey;
    setConfig((prev) => ({
      ...prev,
      [k]: (prev[k] as PricedOption[]).map((o, i) => (i === idx ? { ...o, priceSen } : o)),
    }));
  }

  function updateEntryValue(idx: number, newVal: string) {
    if (isFabricsTab) return;
    if (!newVal.trim()) return;
    const k = tab as MaintenanceListKey;
    if (isPricedTab) {
      setConfig((prev) => ({
        ...prev,
        [k]: (prev[k] as PricedOption[]).map((o, i) => (i === idx ? { ...o, value: newVal } : o)),
      }));
    } else {
      setConfig((prev) => ({
        ...prev,
        [k]: (prev[k] as string[]).map((o, i) => (i === idx ? newVal : o)),
      }));
    }
  }

  function startEditing(idx: number, currentVal: string) {
    setEditingIdx(idx);
    setEditingValue(currentVal);
  }

  function commitEdit(idx: number) {
    updateEntryValue(idx, editingValue);
    setEditingIdx(null);
    setEditingValue("");
  }

  function handleSave() {
    saveMaintenanceConfig(config);
    setSavedSnapshot(JSON.stringify(config));
    showToast("Variants saved");
  }

  function handleReset() {
    if (!window.confirm("Reset all variants to factory defaults? Unsaved changes will be lost.")) return;
    setConfig(DEFAULT_MAINTENANCE_CONFIG);
  }

  // ── Fabric handlers ───────────────────────────────────────────────────────
  function addFabric() {
    const code = newFabricCode.trim().toUpperCase();
    if (!code) return;
    if (fabricsList.some((f) => f.fabricCode === code)) {
      setNewFabricCode("");
      return;
    }
    const priceNum = parseFloat(newFabricPrice || "0") || 0;
    const item: FabricTrackingItem = {
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `fab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fabricCode: code,
      priceTier: newFabricTier,
      price: priceNum,
    };
    setFabricsList((prev) => [...prev, item]);
    pushFabricToApi(item);
    setNewFabricCode("");
    setNewFabricPrice("");
    setNewFabricTier("PRICE_2");
  }

  function updateFabric(id: string, patch: Partial<FabricTrackingItem>) {
    setFabricsList((prev) => {
      const next = prev.map((f) => (f.id === id ? { ...f, ...patch } : f));
      const updated = next.find((f) => f.id === id);
      if (updated) pushFabricToApi(updated);
      return next;
    });
  }

  function removeFabric(id: string) {
    setFabricsList((prev) => prev.filter((f) => f.id !== id));
    deleteFabricFromApi(id);
  }

  const filteredFabrics = useMemo(() => {
    const q = fabricSearch.trim().toLowerCase();
    if (!q) return fabricsList;
    return fabricsList.filter((f) => f.fabricCode.toLowerCase().includes(q));
  }, [fabricsList, fabricSearch]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Save / Reset bar */}
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-gray-500">
          Centralized master data for product variants. Used by BOM, Sales Orders, and Production.
        </p>
        <div className="flex items-center gap-2">
          {isDirty ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
              <AlertCircle className="w-3.5 h-3.5" />
              Saving...
            </span>
          ) : savedSnapshot !== JSON.stringify(DEFAULT_MAINTENANCE_CONFIG) ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-2 py-1">
              Auto-saved
            </span>
          ) : null}
          <button type="button" onClick={handleReset} className={BTN_SECONDARY}>
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!isDirty}
            className={`${BTN_PRIMARY} disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <Save className="w-4 h-4" />
            Save Changes
          </button>
        </div>
      </div>

      {/* Tabs + Content */}
      <div className={`${CARD} overflow-hidden`}>
        <div className="flex border-b border-[#DDE5E5] bg-[#F4F7F7] overflow-x-auto items-end">
          {MAINTENANCE_TABS.map((t, i) => {
            const prevSection = i > 0 ? MAINTENANCE_TABS[i - 1].section : undefined;
            const showSectionLabel = t.section && t.section !== prevSection;
            const count =
              t.key === "fabrics"
                ? fabricsList.length
                : Array.isArray(config[t.key as MaintenanceListKey])
                ? (config[t.key as MaintenanceListKey] as unknown[]).length
                : 0;
            return (
              <div key={t.key} className="flex items-end">
                {showSectionLabel && (
                  <div className="flex items-center self-stretch">
                    {i > 0 && <div className="w-px h-6 bg-[#DDE5E5] mx-1 self-center" />}
                    <span className="text-[9px] font-bold uppercase tracking-wider text-gray-400 px-2 pb-3 self-end">
                      {t.section}
                    </span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setTab(t.key);
                    setNewValue("");
                    setNewPriceSen(0);
                    setEditingIdx(null);
                  }}
                  className={`relative px-3 py-2.5 text-[11px] font-semibold whitespace-nowrap transition-colors ${
                    tab === t.key
                      ? "text-[#0F766E] bg-white border-b-2 border-[#0F766E]"
                      : "text-gray-500 hover:text-[#0F766E] hover:bg-white/60"
                  }`}
                >
                  {t.label}
                  <span className="ml-1 text-[10px] text-gray-400 font-normal tabular-nums">({count})</span>
                </button>
              </div>
            );
          })}
        </div>

        <div className="px-4 py-4">
          <p className="text-[11px] text-gray-500 mb-3">{meta.description}</p>

          {isFabricsTab ? (
            /* ── Fabrics Tab ── */
            <div className="space-y-3">
              {/* Add fabric row */}
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex-1 min-w-[160px]">
                  <p className={FIELD_LABEL}>Fabric Code</p>
                  <input
                    className={FIELD_INPUT}
                    value={newFabricCode}
                    onChange={(e) => setNewFabricCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addFabric();
                      }
                    }}
                    placeholder="e.g. F-123"
                  />
                </div>
                <div className="w-32">
                  <p className={FIELD_LABEL}>Price Tier</p>
                  <select
                    className={FIELD_SELECT}
                    value={newFabricTier}
                    onChange={(e) => setNewFabricTier(e.target.value as "PRICE_1" | "PRICE_2")}
                  >
                    <option value="PRICE_1">Price 1</option>
                    <option value="PRICE_2">Price 2</option>
                  </select>
                </div>
                <div className="w-32">
                  <p className={FIELD_LABEL}>Price (RM)</p>
                  <input
                    type="number"
                    step="0.01"
                    className={FIELD_INPUT}
                    value={newFabricPrice}
                    onChange={(e) => setNewFabricPrice(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
                <button
                  type="button"
                  onClick={addFabric}
                  disabled={!newFabricCode.trim()}
                  className={`${BTN_PRIMARY} disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  <Plus className="w-4 h-4" />
                  Add Fabric
                </button>
              </div>

              {/* Search */}
              <input
                type="text"
                placeholder="Search fabrics by code..."
                value={fabricSearch}
                onChange={(e) => setFabricSearch(e.target.value)}
                className={FIELD_INPUT}
              />

              {/* Fabric table */}
              <div className={`${CARD} overflow-x-auto`}>
                <table className={TABLE}>
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th className={TABLE_HEAD_CELL} style={{ width: "48px" }}>#</th>
                      <th className={TABLE_HEAD_CELL}>Code</th>
                      <th className={TABLE_HEAD_CELL} style={{ width: "130px" }}>Price Tier</th>
                      <th className={TABLE_HEAD_CELL + " text-right"} style={{ width: "110px" }}>Price (RM)</th>
                      <th className={TABLE_HEAD_CELL + " text-center"} style={{ width: "60px" }}>Action</th>
                    </tr>
                  </thead>
                  <tbody className={TABLE_BODY}>
                    {filteredFabrics.length === 0 ? (
                      <tr>
                        <td className={TABLE_CELL + " text-center py-4 text-gray-400"} colSpan={5}>
                          No fabrics yet. Add one above to get started.
                        </td>
                      </tr>
                    ) : (
                      filteredFabrics.map((f, idx) => (
                        <tr key={f.id} className="hover:bg-[#F4F7F7]">
                          <td className={TABLE_CELL + " text-gray-400 font-mono text-[10px]"}>{idx + 1}</td>
                          <td className={TABLE_CELL + " font-mono font-semibold text-[#0A1F2E]"}>
                            {f.fabricCode}
                          </td>
                          <td className={TABLE_CELL}>
                            <select
                              className={FILTER_SELECT}
                              value={f.priceTier}
                              onChange={(e) =>
                                updateFabric(f.id, {
                                  priceTier: e.target.value as "PRICE_1" | "PRICE_2",
                                })
                              }
                            >
                              <option value="PRICE_1">Price 1</option>
                              <option value="PRICE_2">Price 2</option>
                            </select>
                          </td>
                          <td className={TABLE_CELL + " text-right"}>
                            <input
                              type="number"
                              step="0.01"
                              value={f.price}
                              onChange={(e) =>
                                updateFabric(f.id, { price: parseFloat(e.target.value || "0") || 0 })
                              }
                              className="w-full h-7 rounded-md border border-[#DDE5E5] px-1.5 text-[11px] text-right bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]"
                            />
                          </td>
                          <td className={TABLE_CELL + " text-center"}>
                            <button
                              type="button"
                              onClick={() => removeFabric(f.id)}
                              className="p-1 text-gray-400 hover:text-red-600 rounded"
                              title="Remove"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            /* ── Normal list tabs ── */
            <>
              {/* Add row */}
              <div className="flex gap-2 mb-3 items-end">
                <div className="flex-1">
                  <p className={FIELD_LABEL}>Value</p>
                  <input
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addEntry();
                      }
                    }}
                    placeholder={`Add new ${meta.label.toLowerCase().replace(/s$/, "")}...`}
                    className={FIELD_INPUT}
                  />
                </div>
                {isPricedTab && (
                  <div className="w-28">
                    <p className={FIELD_LABEL}>+RM</p>
                    <input
                      type="number"
                      step="0.01"
                      value={newPriceSen / 100}
                      onChange={(e) =>
                        setNewPriceSen(Math.round(parseFloat(e.target.value || "0") * 100))
                      }
                      className={FIELD_INPUT + " text-right"}
                      placeholder="0.00"
                    />
                  </div>
                )}
                <button
                  type="button"
                  onClick={addEntry}
                  disabled={!newValue.trim()}
                  className={`${BTN_PRIMARY} disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  <Plus className="w-4 h-4" />
                  Add
                </button>
              </div>

              {/* List */}
              <div className="space-y-1">
                {isPricedTab ? (
                  currentPricedList.length === 0 ? (
                    <div className="text-center py-8 text-[11px] text-gray-400 bg-[#F4F7F7] rounded-md border border-dashed border-[#DDE5E5]">
                      No entries yet. Add one above to get started.
                    </div>
                  ) : (
                    currentPricedList.map((entry, idx) => (
                      <div
                        key={`${tab}-${idx}`}
                        className="flex items-center justify-between px-2.5 py-1.5 bg-white border border-[#DDE5E5] rounded-md hover:bg-[#F4F7F7] transition-colors group"
                      >
                        <div
                          className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
                          onClick={() => {
                            if (editingIdx !== idx) startEditing(idx, entry.value);
                          }}
                        >
                          <span className="text-[10px] text-gray-400 font-mono w-6 flex-shrink-0 tabular-nums">
                            {idx + 1}
                          </span>
                          {editingIdx === idx ? (
                            <input
                              autoFocus
                              value={editingValue}
                              onChange={(e) => setEditingValue(e.target.value)}
                              onBlur={() => commitEdit(idx)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  commitEdit(idx);
                                }
                                if (e.key === "Escape") {
                                  setEditingIdx(null);
                                  setEditingValue("");
                                }
                              }}
                              onClick={(e) => e.stopPropagation()}
                              className="text-[11px] font-medium border-2 border-[#0F766E] rounded px-2 py-0.5 bg-[#F4F7F7] focus:outline-none w-48"
                            />
                          ) : (
                            <span className="text-[11px] text-[#0A1F2E] font-medium group-hover:text-[#0F766E] inline-flex items-center gap-1">
                              {entry.value}
                              <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-100 text-gray-400" />
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] text-gray-400">+RM</span>
                            <input
                              type="number"
                              step="0.01"
                              value={entry.priceSen / 100}
                              onChange={(e) =>
                                updatePrice(
                                  idx,
                                  Math.round(parseFloat(e.target.value || "0") * 100),
                                )
                              }
                              className="w-20 h-7 text-right text-[11px] border border-[#DDE5E5] rounded px-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => removeEntry(idx)}
                            className="p-1 text-gray-400 hover:text-red-600 rounded"
                            title="Remove"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))
                  )
                ) : currentStringList.length === 0 ? (
                  <div className="text-center py-8 text-[11px] text-gray-400 bg-[#F4F7F7] rounded-md border border-dashed border-[#DDE5E5]">
                    No entries yet. Add one above to get started.
                  </div>
                ) : (
                  currentStringList.map((entry, idx) => (
                    <div
                      key={`${tab}-${idx}`}
                      className="flex items-center justify-between px-2.5 py-1.5 bg-white border border-[#DDE5E5] rounded-md hover:bg-[#F4F7F7] transition-colors group"
                    >
                      <div
                        className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
                        onClick={() => {
                          if (editingIdx !== idx) startEditing(idx, entry);
                        }}
                      >
                        <span className="text-[10px] text-gray-400 font-mono w-6 flex-shrink-0 tabular-nums">
                          {idx + 1}
                        </span>
                        {editingIdx === idx ? (
                          <input
                            autoFocus
                            value={editingValue}
                            onChange={(e) => setEditingValue(e.target.value)}
                            onBlur={() => commitEdit(idx)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitEdit(idx);
                              }
                              if (e.key === "Escape") {
                                setEditingIdx(null);
                                setEditingValue("");
                              }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="text-[11px] font-medium border-2 border-[#0F766E] rounded px-2 py-0.5 bg-[#F4F7F7] focus:outline-none w-48"
                          />
                        ) : (
                          <span className="text-[11px] text-[#0A1F2E] font-medium group-hover:text-[#0F766E] inline-flex items-center gap-1">
                            {entry}
                            <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-100 text-gray-400" />
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeEntry(idx)}
                        className="p-1 text-gray-400 hover:text-red-600 rounded"
                        title="Remove"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Info footer */}
      <div className="text-[10px] text-gray-400 bg-[#F4F7F7] border border-[#DDE5E5] rounded-md p-2.5">
        Variants stored in browser localStorage (
        <code className="bg-white px-1 rounded border border-[#DDE5E5]">{MAINTENANCE_STORAGE_KEY}</code>
        ). Fabrics stored in{" "}
        <code className="bg-white px-1 rounded border border-[#DDE5E5]">{FABRIC_STORAGE_KEY}</code>.
      </div>

      {/* Toast */}
      {toastVisible && (
        <div className="fixed bottom-6 right-6 inline-flex items-center gap-2 px-4 py-2.5 bg-[#0F766E] text-white rounded-lg shadow-lg text-[12px] font-semibold">
          <Check className="w-4 h-4" />
          {toastMsg}
        </div>
      )}
    </div>
  );
}
