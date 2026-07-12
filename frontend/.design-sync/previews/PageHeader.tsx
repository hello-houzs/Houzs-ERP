import { PageHeader, Button, Badge } from "autocount-sync-frontend";
import { Download, Printer } from "lucide-react";

// Sticky page title strip — title + optional eyebrow/description, an
// always-visible primary CTA and collapsible secondary actions.

export const TitleOnly = () => <PageHeader title="Sales Orders" />;

export const WithDescriptionAndCta = () => (
  <PageHeader
    eyebrow="Supply Chain"
    title="Delivery Orders"
    description="Outbound deliveries synced from AutoCount, newest first."
    primaryAction={<Button variant="primary">New DO</Button>}
  />
);

export const WithSecondaryActions = () => (
  <PageHeader
    title="Service Cases"
    description="After-sales service requests across all outlets."
    actions={<Badge tone="warning">Sync paused</Badge>}
    primaryAction={<Button variant="primary">New Case</Button>}
    secondaryActions={[
      { icon: Download, label: "Export CSV", onClick: () => {} },
      { icon: Printer, label: "Print list", onClick: () => {} },
    ]}
  />
);

export const Dense = () => (
  <PageHeader
    dense
    title="P&L Calendar"
    description="Daily gross margin at a glance."
  />
);
