import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, RotateCcw } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { LookupManager } from "../components/LookupManager";
import { Button } from "../components/Button";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { api } from "../api/client";

/**
 * Sales Team Maintenance — picker management for the retail-rep
 * org chart. Mirrors the Project Maintenance + Service Maintenance
 * pattern; each section uses the shared <LookupManager>.
 *
 * Mounted at /sales-team-maintenance, gated by `sales_team.manage`.
 */
export function SalesTeamMaintenance() {
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();
  const [resetting, setResetting] = useState(false);

  async function resetPositions() {
    if (
      !(await dialog.confirm({
        title: "Reset positions to seed?",
        message:
          "This wipes the existing Director / Executive / Sub-Executive lookup rows and re-creates them from the boss-approved defaults. Reps with one of these positions will keep working; renamed or custom positions are lost.",
        danger: true,
        confirmLabel: "Reset",
      }))
    )
      return;
    setResetting(true);
    try {
      await api.post("/api/sales-team/reset-positions");
      toast.success("Positions reset to seed");
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setResetting(false);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Workspace · Sales"
        title="Sales Team Maintenance"
        description="Picker lists that drive the rep registration form — positions and commission tiers. Edit here once, every form updates."
        primaryAction={
          <Button
            variant="ghost"
            icon={<ArrowLeft size={14} />}
            onClick={() => navigate("/sales-team")}
          >
            Back to Sales Team
          </Button>
        }
        secondaryActions={[
          {
            icon: RotateCcw,
            label: resetting ? "Resetting…" : "Reset positions",
            onClick: resetPositions,
            danger: true,
          },
        ]}
      />

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <LookupManager
          apiPath="/api/sales-team/lookups/positions"
          title="Positions"
          description="Director / Executive / Sub-Executive ladder. Level (10 = top) drives the org-chart sort order. Renaming a position cascades to existing reps."
          extra={{
            key: "level",
            addLabel: "Level",
            rowTitle: "10 = Director, 20 = Executive, 30 = Sub-Executive",
            placeholder: "20",
            step: "10",
            min: 0,
            width: "w-20",
          }}
        />
        <LookupManager
          apiPath="/api/sales-team/lookups/commission-tiers"
          title="Commission Tiers"
          description="Named tiers (e.g. Standard 5%, Director 8%) that members can be assigned to. Per-member rate override on the rep detail page beats the tier."
          extra={{
            key: "rate",
            addLabel: "Rate %",
            rowTitle: "Commission rate as a percent (5 = 5%)",
            placeholder: "5",
            step: "0.5",
            min: 0,
            width: "w-20",
          }}
        />
      </div>
    </div>
  );
}
