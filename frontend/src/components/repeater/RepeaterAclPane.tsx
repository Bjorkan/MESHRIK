import { tableFeatures, useTable, type ColumnDef } from '@tanstack/react-table';
import { cn } from '@/lib/utils';
import { RepeaterPane, NotFetched } from './repeaterPaneShared';
import type { RepeaterAclResponse, PaneState } from '../../types';

type AclEntry = RepeaterAclResponse['acl'][number];

const aclTableFeatures = tableFeatures({});
const emptyAcl: AclEntry[] = [];
const aclColumns = [
  {
    id: 'name',
    header: 'Name',
    accessorFn: (entry: AclEntry) => entry.name || entry.pubkey_prefix,
  },
  { accessorKey: 'permission_name', id: 'permission', header: 'Permission' },
] satisfies Array<ColumnDef<typeof aclTableFeatures, AclEntry>>;

export function AclPane({
  data,
  state,
  onRefresh,
  disabled,
}: {
  data: RepeaterAclResponse | null;
  state: PaneState;
  onRefresh: () => void;
  disabled?: boolean;
}) {
  const permColor: Record<number, string> = {
    0: 'bg-muted text-muted-foreground',
    1: 'bg-info/10 text-info',
    2: 'bg-success/10 text-success',
    3: 'bg-warning/10 text-warning',
  };
  const table = useTable({
    features: aclTableFeatures,
    columns: aclColumns,
    data: data?.acl ?? emptyAcl,
  });

  return (
    <RepeaterPane title="ACL" state={state} onRefresh={onRefresh} disabled={disabled}>
      {!data ? (
        <NotFetched />
      ) : data.acl.length === 0 ? (
        <p className="text-sm text-muted-foreground">No ACL entries</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id} className="text-left text-muted-foreground text-xs">
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    className={cn('pb-1 font-medium', header.id === 'permission' && 'text-right')}
                  >
                    <table.FlexRender header={header} />
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const entry = row.original;
              return (
                <tr key={row.id} className="border-t border-border/50">
                  <td className="py-1">{entry.name || entry.pubkey_prefix}</td>
                  <td className="py-1 text-right">
                    <span
                      className={cn(
                        'text-xs px-1.5 py-0.5 rounded',
                        permColor[entry.permission] ?? 'bg-muted text-muted-foreground'
                      )}
                    >
                      {entry.permission_name}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </RepeaterPane>
  );
}
