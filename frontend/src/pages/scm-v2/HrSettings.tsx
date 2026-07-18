// ----------------------------------------------------------------------------
// HR Settings — who earns commission, at what rates, and which items carry a
// fixed per-unit bonus. Writes PATCH /config, and CRUD on /profiles + /item-kpi
// (all under /api/scm/hr, all gated server-side on scm.hr.manage).
//
// EDIT -> SAVE, never naked edits (house rule): tier / showroom / active and
// every rate buffer into a draft and NOTHING persists until Save. The add rows
// and the delete button are explicit single actions, so they commit directly —
// deletes behind an in-app confirm.
//
// Page shell is Inventory's (PageHeader + space-y-4), not the vendored 2990
// card slab — owner 2026-07-18.
// ----------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { fmtCenti } from '@2990s/shared';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import {
  useHrConfig, useUpdateHrConfig,
  useHrProfiles, useCreateHrProfile, useUpdateHrProfile, useDeleteHrProfile,
  useHrItemKpi, useCreateHrItemKpi, useDeleteHrItemKpi,
  useHrPickers,
  type HrConfigPatch, type HrFlagType, type HrPickerRef, type HrTier,
} from '../../vendor/scm/lib/hr-queries';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const INPUT_CLASS =
  'w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60';

const SECTION_CLASS = 'space-y-2';
const TABLE_WRAP_CLASS = 'overflow-x-auto rounded-md border border-border bg-surface';
const THEAD_CLASS = 'bg-bg/40 text-[9px] font-semibold uppercase tracking-wider text-ink-muted';

const Label = ({ children }: { children: string }) => (
  <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{children}</span>
);

const SectionHeading = ({ children }: { children: string }) => (
  <h2 className="text-[14px] font-semibold text-ink">{children}</h2>
);

/* A rate held as integer basis points, edited as a percent. The bps never
   changes shape in flight: it is divided by 100 to render and multiplied back
   by exactly 100 with Math.round on the way out. */
const RateField = ({
  label, bps, editable, onChange,
}: { label: string; bps: number; editable: boolean; onChange: (bps: number) => void }) => {
  const [text, setText] = useState((bps / 100).toString());
  // Resync when the server value moves under us (save, refetch, concurrent edit).
  useEffect(() => setText((bps / 100).toString()), [bps]);
  return (
    <label className="flex flex-col gap-1">
      <Label>{label}</Label>
      <input
        className={INPUT_CLASS}
        type="number"
        step="0.1"
        min={0}
        value={text}
        disabled={!editable}
        onChange={(e) => setText(e.target.value)}
        /* An EMPTY box is not 0%. Number('') === 0, so accepting it would stage
           a 0% base rate that reads as a deliberate edit — on this page that is
           everybody's pay. Blank reverts to the server value instead. */
        onBlur={() => {
          const n = Number(text);
          if (text.trim() === '' || !Number.isFinite(n) || n < 0) {
            setText((bps / 100).toString());
            return;
          }
          onChange(Math.round(n * 100));
        }}
      />
    </label>
  );
};

/** A money threshold held as integer sen, edited as ringgit. */
const CentiField = ({
  label, centi, editable, onChange,
}: { label: string; centi: number; editable: boolean; onChange: (centi: number) => void }) => {
  const [text, setText] = useState((centi / 100).toString());
  useEffect(() => setText((centi / 100).toString()), [centi]);
  return (
    <label className="flex flex-col gap-1">
      <Label>{label}</Label>
      <input
        className={INPUT_CLASS}
        type="number"
        min={0}
        value={text}
        disabled={!editable}
        onChange={(e) => setText(e.target.value)}
        // Blank is "unknown", not RM 0 — see RateField.
        onBlur={() => {
          const n = Number(text);
          if (text.trim() === '' || !Number.isFinite(n) || n < 0) {
            setText((centi / 100).toString());
            return;
          }
          onChange(Math.round(n * 100));
        }}
      />
    </label>
  );
};

type ProfileDraft = { tier?: HrTier; showroomId?: string; active?: boolean };

export const HrSettings = () => {
  const profiles = useHrProfiles();
  const pickers = useHrPickers();
  const createProfile = useCreateHrProfile();
  const updateProfile = useUpdateHrProfile();
  const deleteProfile = useDeleteHrProfile();

  const config = useHrConfig();
  const updateConfig = useUpdateHrConfig();

  const itemKpi = useHrItemKpi();
  const createItemKpi = useCreateHrItemKpi();
  const deleteItemKpi = useDeleteHrItemKpi();

  const askConfirm = useConfirm();
  const notify = useNotify();

  const [editMode, setEditMode] = useState(false);
  const [profileDraft, setProfileDraft] = useState<Record<string, ProfileDraft>>({});
  const [cfgDraft, setCfgDraft] = useState<HrConfigPatch>({});
  const [saving, setSaving] = useState(false);

  const [newStaff, setNewStaff] = useState('');
  const [newTier, setNewTier] = useState<HrTier>('sales');
  const [newShowroom, setNewShowroom] = useState('');

  const [flagType, setFlagType] = useState<HrFlagType>('product');
  const [flagRef, setFlagRef] = useState('');
  const [flagBonus, setFlagBonus] = useState('');

  const cfg = config.data;
  const showrooms = pickers.data?.showrooms ?? [];
  const dirtyCount = Object.keys(profileDraft).length + Object.keys(cfgDraft).length;

  const stageProfile = (id: string, patch: ProfileDraft) =>
    setProfileDraft((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  const stageCfg = (patch: HrConfigPatch) => setCfgDraft((prev) => ({ ...prev, ...patch }));

  const cancelEdits = () => {
    setProfileDraft({});
    setCfgDraft({});
    setEditMode(false);
  };

  const saveEdits = async () => {
    setSaving(true);
    try {
      for (const [id, patch] of Object.entries(profileDraft)) {
        await updateProfile.mutateAsync({ id, ...patch });
      }
      if (Object.keys(cfgDraft).length > 0) await updateConfig.mutateAsync(cfgDraft);
      setProfileDraft({});
      setCfgDraft({});
      setEditMode(false);
    } catch (e) {
      /* The draft is deliberately NOT cleared and edit mode stays open: the
         rates on screen are what the user meant to save, and silently dropping
         them on a failed request would look like the save succeeded. */
      await notify({ title: 'Could not save', body: (e as Error)?.message, tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const refList: HrPickerRef[] =
    flagType === 'product' ? pickers.data?.products ?? []
      : flagType === 'fabric' ? pickers.data?.fabrics ?? []
        : pickers.data?.specials ?? [];

  const addProfile = async () => {
    if (!newStaff || !newShowroom) return;
    try {
      await createProfile.mutateAsync({ staffId: newStaff, tier: newTier, showroomId: newShowroom });
      setNewStaff('');
      setNewShowroom('');
    } catch (e) {
      await notify({ title: 'Could not add salesperson', body: (e as Error)?.message, tone: 'error' });
    }
  };

  const addItemKpi = async () => {
    const bonus = Number(flagBonus);
    if (!flagRef || !Number.isFinite(bonus) || bonus <= 0) return;
    const label = refList.find((r) => r.ref === flagRef)?.label ?? flagRef;
    try {
      await createItemKpi.mutateAsync({
        flagType,
        ref: flagRef,
        label,
        bonusCenti: Math.round(bonus * 100),
      });
      setFlagRef('');
      setFlagBonus('');
    } catch (e) {
      await notify({ title: 'Could not add item KPI', body: (e as Error)?.message, tone: 'error' });
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="HR"
        title="HR Settings"
        primaryAction={
          editMode ? (
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={cancelEdits} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" onClick={saveEdits} disabled={saving || dirtyCount === 0}>
                {saving ? 'Saving…' : dirtyCount > 0 ? `Save (${dirtyCount})` : 'Save'}
              </Button>
            </div>
          ) : (
            <Button variant="primary" onClick={() => setEditMode(true)}>
              Edit
            </Button>
          )
        }
      />

      {/* A failed read must never look like an empty list — "no salespeople
          configured" and "we could not ask" are different answers, and only one
          of them means nobody gets paid. */}
      {config.isError && (
        <div className="rounded-md border border-err/40 bg-err/5 px-3 py-3 text-[13px] text-ink">
          {(config.error as Error)?.message || 'The commission rate settings could not be loaded.'}
        </div>
      )}
      {profiles.isError && (
        <div className="rounded-md border border-err/40 bg-err/5 px-3 py-3 text-[13px] text-ink">
          {(profiles.error as Error)?.message || 'The salesperson list could not be loaded.'}
        </div>
      )}
      {itemKpi.isError && (
        <div className="rounded-md border border-err/40 bg-err/5 px-3 py-3 text-[13px] text-ink">
          {(itemKpi.error as Error)?.message || 'The item KPI list could not be loaded.'}
        </div>
      )}

      {/* 1 · Salespeople */}
      <section className={SECTION_CLASS}>
        <SectionHeading>Salespeople</SectionHeading>
        <div className={TABLE_WRAP_CLASS}>
          <table className="w-full text-[12px]">
            <thead className={THEAD_CLASS}>
              <tr>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-2 py-2 text-left">Tier</th>
                <th className="px-2 py-2 text-left">Showroom</th>
                <th className="px-2 py-2 text-left">Active</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {(profiles.data ?? []).map((p) => (
                <tr key={p.id} className="border-t border-border-subtle">
                  <td className="px-3 py-2">
                    <span className="font-semibold text-ink">{p.staffName}</span>{' '}
                    <span className="text-ink-muted">{p.staffCode}</span>
                  </td>
                  <td className="px-2 py-2">
                    <select
                      className={INPUT_CLASS}
                      disabled={!editMode}
                      value={profileDraft[p.id]?.tier ?? p.tier}
                      onChange={(e) => stageProfile(p.id, { tier: e.target.value as HrTier })}
                    >
                      <option value="sales">sales</option>
                      <option value="manager">manager</option>
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <select
                      className={INPUT_CLASS}
                      disabled={!editMode}
                      value={profileDraft[p.id]?.showroomId ?? p.showroomId}
                      onChange={(e) => stageProfile(p.id, { showroomId: e.target.value })}
                    >
                      {showrooms.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <input
                      type="checkbox"
                      disabled={!editMode}
                      checked={profileDraft[p.id]?.active ?? p.active}
                      onChange={(e) => stageProfile(p.id, { active: e.target.checked })}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      aria-label={`Remove ${p.staffName}`}
                      className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err"
                      onClick={async () => {
                        const ok = await askConfirm({
                          title: 'Remove this salesperson?',
                          body: `${p.staffName} will stop appearing on the commission report. Past closed periods keep their frozen figures.`,
                          confirmLabel: 'Remove',
                          danger: true,
                        });
                        if (!ok) return;
                        try {
                          await deleteProfile.mutateAsync(p.id);
                        } catch (e) {
                          await notify({ title: 'Could not remove', body: (e as Error)?.message, tone: 'error' });
                        }
                      }}
                    >
                      <Trash2 {...ICON} />
                    </button>
                  </td>
                </tr>
              ))}
              {(profiles.data ?? []).length === 0 && !profiles.isLoading && !profiles.isError && (
                <tr className="border-t border-border-subtle">
                  <td colSpan={5} className="px-3 py-4 text-center text-[12px] text-ink-secondary">
                    No salespeople configured yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-surface px-3 py-3">
          <label className="flex min-w-[220px] flex-col gap-1">
            <Label>Staff</Label>
            <select className={INPUT_CLASS} value={newStaff} onChange={(e) => setNewStaff(e.target.value)}>
              <option value="">Select…</option>
              {(pickers.data?.staff ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.role})</option>
              ))}
            </select>
          </label>
          <label className="flex min-w-[140px] flex-col gap-1">
            <Label>Tier</Label>
            <select className={INPUT_CLASS} value={newTier} onChange={(e) => setNewTier(e.target.value as HrTier)}>
              <option value="sales">sales</option>
              <option value="manager">manager</option>
            </select>
          </label>
          <label className="flex min-w-[180px] flex-col gap-1">
            <Label>Showroom</Label>
            <select className={INPUT_CLASS} value={newShowroom} onChange={(e) => setNewShowroom(e.target.value)}>
              <option value="">Select…</option>
              {showrooms.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <Button
            variant="primary"
            icon={<Plus {...ICON} />}
            disabled={!newStaff || !newShowroom || createProfile.isPending}
            onClick={addProfile}
          >
            Add
          </Button>
        </div>
      </section>

      {/* 2 · Commission rates */}
      <section className={SECTION_CLASS}>
        <SectionHeading>Commission rates</SectionHeading>
        {cfg && (
          <div className="grid grid-cols-1 gap-3 rounded-md border border-border bg-surface px-3 py-3 sm:grid-cols-2 lg:grid-cols-4">
            <RateField
              label="Base %"
              editable={editMode}
              bps={cfgDraft.baseBps ?? cfg.baseBps}
              onChange={(v) => stageCfg({ baseBps: v })}
            />
            <RateField
              label="Personal KPI +%"
              editable={editMode}
              bps={cfgDraft.personalKpiBonusBps ?? cfg.personalKpiBonusBps}
              onChange={(v) => stageCfg({ personalKpiBonusBps: v })}
            />
            <CentiField
              label="Personal threshold RM"
              editable={editMode}
              centi={cfgDraft.personalKpiThresholdCenti ?? cfg.personalKpiThresholdCenti}
              onChange={(v) => stageCfg({ personalKpiThresholdCenti: v })}
            />
            <RateField
              label="Showroom KPI +%"
              editable={editMode}
              bps={cfgDraft.showroomKpiBonusBps ?? cfg.showroomKpiBonusBps}
              onChange={(v) => stageCfg({ showroomKpiBonusBps: v })}
            />
            <CentiField
              label="Showroom threshold RM"
              editable={editMode}
              centi={cfgDraft.showroomKpiThresholdCenti ?? cfg.showroomKpiThresholdCenti}
              onChange={(v) => stageCfg({ showroomKpiThresholdCenti: v })}
            />
            <RateField
              label="Override base %"
              editable={editMode}
              bps={cfgDraft.overrideBaseBps ?? cfg.overrideBaseBps}
              onChange={(v) => stageCfg({ overrideBaseBps: v })}
            />
            <RateField
              label="Override KPI +%"
              editable={editMode}
              bps={cfgDraft.overrideKpiBonusBps ?? cfg.overrideKpiBonusBps}
              onChange={(v) => stageCfg({ overrideKpiBonusBps: v })}
            />
          </div>
        )}
      </section>

      {/* 3 · Item KPIs */}
      <section className={SECTION_CLASS}>
        <SectionHeading>Item KPIs</SectionHeading>
        <div className={TABLE_WRAP_CLASS}>
          <table className="w-full text-[12px]">
            <thead className={THEAD_CLASS}>
              <tr>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-2 py-2 text-left">Item</th>
                <th className="px-2 py-2 text-right">Bonus / unit</th>
                <th className="px-2 py-2 text-left">Active</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {(itemKpi.data ?? []).map((it) => (
                <tr key={it.id} className="border-t border-border-subtle">
                  <td className="px-3 py-2 text-ink-secondary">{it.flagType}</td>
                  <td className="px-2 py-2 text-ink">{it.label || it.ref}</td>
                  <td className="px-2 py-2 text-right font-mono">{fmtCenti(it.bonusCenti)}</td>
                  <td className="px-2 py-2 text-ink-secondary">{it.active ? 'Yes' : 'No'}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      aria-label={`Remove ${it.label || it.ref}`}
                      className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err"
                      onClick={async () => {
                        const ok = await askConfirm({
                          title: 'Remove this item KPI?',
                          body: 'It will stop adding a bonus on future commission runs.',
                          confirmLabel: 'Remove',
                          danger: true,
                        });
                        if (!ok) return;
                        try {
                          await deleteItemKpi.mutateAsync(it.id);
                        } catch (e) {
                          await notify({ title: 'Could not remove', body: (e as Error)?.message, tone: 'error' });
                        }
                      }}
                    >
                      <Trash2 {...ICON} />
                    </button>
                  </td>
                </tr>
              ))}
              {(itemKpi.data ?? []).length === 0 && !itemKpi.isLoading && !itemKpi.isError && (
                <tr className="border-t border-border-subtle">
                  <td colSpan={5} className="px-3 py-4 text-center text-[12px] text-ink-secondary">
                    No item KPIs configured yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-surface px-3 py-3">
          <label className="flex min-w-[140px] flex-col gap-1">
            <Label>Type</Label>
            <select
              className={INPUT_CLASS}
              value={flagType}
              onChange={(e) => {
                setFlagType(e.target.value as HrFlagType);
                setFlagRef('');
              }}
            >
              <option value="product">product</option>
              <option value="fabric">fabric</option>
              <option value="special">special</option>
            </select>
          </label>
          <label className="flex min-w-[260px] flex-col gap-1">
            <Label>Item</Label>
            <select className={INPUT_CLASS} value={flagRef} onChange={(e) => setFlagRef(e.target.value)}>
              <option value="">Select…</option>
              {refList.map((r) => (
                <option key={r.ref} value={r.ref}>{r.label}</option>
              ))}
            </select>
          </label>
          <label className="flex min-w-[160px] flex-col gap-1">
            <Label>Bonus RM / unit</Label>
            <input
              className={INPUT_CLASS}
              type="number"
              min={0}
              value={flagBonus}
              onChange={(e) => setFlagBonus(e.target.value)}
            />
          </label>
          <Button
            variant="primary"
            icon={<Plus {...ICON} />}
            disabled={!flagRef || !(Number(flagBonus) > 0) || createItemKpi.isPending}
            onClick={addItemKpi}
          >
            Add
          </Button>
        </div>
      </section>
    </div>
  );
};
