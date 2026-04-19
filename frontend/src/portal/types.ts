export type PortalStatusColor = "grey" | "blue" | "amber" | "violet" | "green";

export interface PortalCaseDetail {
  case: {
    id: number;
    assr_no: string;
    customer_name: string | null;
    complained_date: string | null;
    complaint_issue: string | null;
    category: string | null;
    status_label: string;
    status_color: PortalStatusColor;
    stage: string;
    expected_resolution_at: string | null;
    completion_date: string | null;
    closed_at: string | null;
    satisfaction_rating: number | null;
  };
  items: Array<{
    id: number;
    item_code: string;
    item_description: string | null;
    qty: number | null;
  }>;
  attachments: Array<{
    id: number;
    category: string;
    file_name: string | null;
    content_type: string | null;
    source: "staff" | "customer" | "system" | null;
    created_at: string;
  }>;
  timeline: Array<{
    id: number;
    action: string;
    label: string;
    at: string;
    source: "staff" | "customer" | "system";
    note?: string;
  }>;
}
