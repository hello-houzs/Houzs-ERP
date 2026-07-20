import type { QueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

type SoDetailCache = { salesOrder?: { version?: number | string } };
type LeaseReservation = { version: number; leaseToken: string };

const leaseToken = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `so-lease-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export async function resolveLoadedSoVersion(qc: QueryClient, docNo: string): Promise<number> {
  const cached = qc.getQueryData<SoDetailCache>(['mfg-sales-order-detail', docNo]);
  let raw = cached?.salesOrder?.version;
  if (raw === undefined) {
    const loaded = await authedFetch<SoDetailCache>(`/mfg-sales-orders/${docNo}`);
    raw = loaded.salesOrder?.version;
    qc.setQueryData(['mfg-sales-order-detail', docNo], loaded);
  }
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('This order has no concurrency version. Refresh the order before changing it.');
  }
  return version;
}

/**
 * Runs one standalone line mutation inside the same version/lease protocol as
 * the page-level composite save. A stale screen loses at reservation time, so
 * its action is never sent; a failed action retains all caller input and the
 * lease is released in finally.
 */
export async function runSoVersionedMutation<T>(
  qc: QueryClient,
  docNo: string,
  actionName: string,
  action: (reservation: LeaseReservation) => Promise<T>,
): Promise<T> {
  const token = leaseToken();
  const version = await resolveLoadedSoVersion(qc, docNo);
  const reserved = await authedFetch<{ version: number; leaseToken: string }>(
    `/mfg-sales-orders/${docNo}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        version,
        reserveLineWrites: true,
        lineWriteLeaseToken: token,
      }),
    },
  );
  const reservation = { version: Number(reserved.version), leaseToken: reserved.leaseToken || token };
  try {
    return await action(reservation);
  } finally {
    try {
      await authedFetch(`/mfg-sales-orders/${docNo}`, {
        method: 'PATCH',
        headers: { 'X-SO-Edit-Action': actionName },
        body: JSON.stringify({
          version: reservation.version,
          completeLineWrites: true,
          lineWriteLeaseToken: reservation.leaseToken,
        }),
      });
    } catch (releaseError) {
      // Never turn a successfully committed action into a visible failure just
      // because its expiring lease could not be cleared. The detail refresh
      // below advances the version; the five-minute expiry is the backstop.
      console.warn('[so-versioned-mutation] lease release failed', releaseError);
    }
    qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', docNo] });
  }
}
