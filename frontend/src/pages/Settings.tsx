import { useState } from "react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { StatusDot } from "../components/StatusDot";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { relativeTime } from "../lib/utils";
import type { SyncStatusResponse } from "../types";

export function Settings() {
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  const [connectionOk, setConnectionOk] = useState<boolean | null>(null);
  const [retrying, setRetrying] = useState(false);

  const status = useQuery<SyncStatusResponse>(() => api.get("/api/sync/status"));

  async function testConnection() {
    setTesting(true);
    try {
      await fetch(`${api.baseUrl}/health`);
      setConnectionOk(true);
      toast.success("Connection OK");
    } catch (e: any) {
      setConnectionOk(false);
      toast.error(`Connection failed: ${e?.message || e}`);
    } finally {
      setTesting(false);
    }
  }

  async function retryAll() {
    setRetrying(true);
    try {
      const res: any = await api.post("/api/sync/retry-errors");
      toast.success(`Retried ${res?.attempted ?? 0}, synced ${res?.synced ?? 0}`);
      status.reload();
    } catch (e: any) {
      toast.error(`Retry failed: ${e?.message || e}`);
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        eyebrow="System · Configuration"
        title="Settings"
        description="Connection and sync state"
      />

      <section className="mb-6 relative overflow-hidden rounded-md border border-border bg-surface p-6 shadow-stone">
        <h2 className="mb-5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">Connection</h2>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">API URL</span>
            <span className="font-mono text-xs">{api.baseUrl || "(not set)"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">Status</span>
            {connectionOk === null ? (
              <span className="text-xs text-ink-muted">Not tested</span>
            ) : connectionOk ? (
              <StatusDot variant="synced" label="Connected" />
            ) : (
              <StatusDot variant="error" label="Disconnected" />
            )}
          </div>
          <div className="pt-2">
            <Button variant="secondary" onClick={testConnection} disabled={testing}>
              {testing ? "Testing…" : "Test Connection"}
            </Button>
          </div>
        </div>
      </section>

      <section className="relative overflow-hidden rounded-md border border-border bg-surface p-6 shadow-stone">
        <h2 className="mb-5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">Sync — Filtered (cron)</h2>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">Last pull</span>
            <span className="font-mono text-xs">
              {status.data?.last_pull
                ? `${relativeTime(status.data.last_pull.started_at)} (${status.data.last_pull.status})`
                : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">Checkpoint</span>
            <span className="font-mono text-xs">{status.data?.checkpoint || "—"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">Sync errors</span>
            <span className="font-mono text-xs">{status.data?.error_count ?? 0}</span>
          </div>
          {(status.data?.error_count ?? 0) > 0 && (
            <div className="pt-2">
              <Button variant="danger" onClick={retryAll} disabled={retrying}>
                {retrying ? "Retrying…" : "Retry All Errors"}
              </Button>
            </div>
          )}
        </div>
      </section>

      <section className="mt-6 relative overflow-hidden rounded-md border border-border bg-surface p-6 shadow-stone">
        <h2 className="mb-1 text-sm font-semibold">Sync — Full Refresh</h2>
        <p className="mb-4 text-xs text-ink-muted">
          Calls <span className="font-mono">/SalesOrder/getAll</span> and upserts
          everything — ignores server-side Remark2/Attention/Remark4/
          SalesExemptionExpiryDate filters. No checkpoint; the entire list is
          re-fetched each run. Manual only — not on the cron.
        </p>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">Last full refresh</span>
            <span className="font-mono text-xs">
              {status.data?.last_pull_all
                ? `${relativeTime(status.data.last_pull_all.started_at)} (${status.data.last_pull_all.status})`
                : "Never"}
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
