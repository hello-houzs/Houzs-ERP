// ---------------------------------------------------------------------------
// dp-party.ts — resolve a DP Order's PARTY snapshot from the right master.
//
// Owner spec 2026-07-18: each job type auto-fills its party from a DIFFERENT
// master, and the masters DISAGREE on shape (survey 2026-07-18). So the DP Order
// stores its OWN flat snapshot; these pure mappers translate each master row into
// that one shape. No DB here — the route reads the row, these map it — so every
// mapping is unit-tested without a database.
//
//   DELIVERY / PICKUP / SERVICE → CUSTOMER  (SO header, or the service case)
//   SUPPLIER_PICKUP             → SUPPLIER   (scm.suppliers — single-line address)
//   SETUP / DISMANTLE           → VENUE      (public.projects; PIC from public.users)
// ---------------------------------------------------------------------------

export type DpJobType = 'DELIVERY' | 'PICKUP' | 'SERVICE' | 'SETUP' | 'DISMANTLE' | 'SUPPLIER_PICKUP';
export type DpPartyType = 'CUSTOMER' | 'SUPPLIER' | 'VENUE';

export interface DpPartySnapshot {
  party_type: DpPartyType;
  party_name: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
  city: string | null;
  postcode: string | null;
  state: string | null;
}

/** Which master a job type draws its party from. */
export function partyTypeFor(jobType: DpJobType): DpPartyType {
  switch (jobType) {
    case 'SUPPLIER_PICKUP': return 'SUPPLIER';
    case 'SETUP':
    case 'DISMANTLE': return 'VENUE';
    default: return 'CUSTOMER'; // DELIVERY / PICKUP / SERVICE
  }
}

const s = (v: unknown): string | null => {
  const t = (v == null ? '' : String(v)).trim();
  return t === '' ? null : t;
};

/** From an scm.mfg_sales_orders header row. The SO has NO contact-person column
 *  (survey), so contact_name is null; the debtor is the party. */
export function snapshotFromSo(row: Record<string, unknown>): DpPartySnapshot {
  return {
    party_type: 'CUSTOMER',
    party_name: s(row.debtor_name),
    contact_name: null,
    contact_phone: s(row.phone),
    address1: s(row.address1), address2: s(row.address2), address3: s(row.address3), address4: s(row.address4),
    city: s(row.city), postcode: s(row.postcode),
    state: s(row.customer_state),
  };
}

/** From an scm.suppliers row. The supplier master has a SINGLE free-text address
 *  (survey — no address1-4, no city), so it maps to address1 and city stays null.
 *  contact_name prefers contact_person, then attention; phone prefers phone, then
 *  mobile. */
export function snapshotFromSupplier(row: Record<string, unknown>): DpPartySnapshot {
  return {
    party_type: 'SUPPLIER',
    party_name: s(row.name),
    contact_name: s(row.contact_person) ?? s(row.attention),
    contact_phone: s(row.phone) ?? s(row.mobile),
    address1: s(row.address), address2: null, address3: null, address4: null,
    city: null, postcode: s(row.postcode),
    state: s(row.state),
  };
}

/** From a public.projects row + the PIC's public.users row. The project's PIC is
 *  a users(id) FK (survey), so the contact NAME/PHONE come from the user, not the
 *  project. The venue address is a single free-text line → address1. */
export function snapshotFromProject(
  proj: Record<string, unknown>,
  picUser: Record<string, unknown> | null,
): DpPartySnapshot {
  return {
    party_type: 'VENUE',
    party_name: s(proj.venue) ?? s(proj.organizer),
    contact_name: picUser ? s(picUser.name) : null,
    contact_phone: picUser ? s(picUser.phone) : null,
    address1: s(proj.venue_address), address2: null, address3: null, address4: null,
    city: null, postcode: null,
    state: s(proj.state),
  };
}

/** From a public.assr_cases row (a service case → SERVICE / PICKUP). No postcode
 *  or dedicated state column (survey); `location` doubles as the region/state. */
export function snapshotFromAssr(row: Record<string, unknown>): DpPartySnapshot {
  return {
    party_type: 'CUSTOMER',
    party_name: s(row.customer_name),
    contact_name: null,
    contact_phone: s(row.phone),
    address1: s(row.addr1), address2: s(row.addr2), address3: s(row.addr3), address4: s(row.addr4),
    city: null, postcode: null,
    state: s(row.location),
  };
}

/** An empty snapshot of the right party type — for a manual DP order with no
 *  source document, where the operator types the fields. */
export function emptySnapshot(jobType: DpJobType): DpPartySnapshot {
  return {
    party_type: partyTypeFor(jobType),
    party_name: null, contact_name: null, contact_phone: null,
    address1: null, address2: null, address3: null, address4: null,
    city: null, postcode: null, state: null,
  };
}
