import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { RepeaterPane, NotFetched, KvRow } from './repeaterPaneShared';
import type { RepeaterOwnerInfoResponse, PaneState } from '../../types';

function LabeledBlock({ label, value }: { label: string; value: string }) {
  useLingui();

  return (
    <div className="py-0.5">
      <span className="text-sm text-muted-foreground whitespace-nowrap">{label}</span>
      <p className="text-sm font-medium mt-0.5 break-words">{value}</p>
    </div>
  );
}

export function OwnerInfoPane({
  data,
  state,
  onRefresh,
  disabled,
}: {
  data: RepeaterOwnerInfoResponse | null;
  state: PaneState;
  onRefresh: () => void;
  disabled?: boolean;
}) {
  useLingui();

  return (
    <RepeaterPane title={t`Owner Info`} state={state} onRefresh={onRefresh} disabled={disabled}>
      {!data ? (
        <NotFetched />
      ) : (
        <div className="space-y-1">
          <LabeledBlock label={t`Owner Info`} value={data.owner_info ?? '—'} />
          <KvRow label={t`Firmware`} value={data.firmware_version ?? '—'} />
          {data.name && <KvRow label={t`Name`} value={data.name} />}
          <KvRow label={t`Guest Password`} value={data.guest_password ?? '—'} />
        </div>
      )}
    </RepeaterPane>
  );
}
