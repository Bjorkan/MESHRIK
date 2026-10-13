import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  createFilteredRowModel,
  createSortedRowModel,
  columnFilteringFeature,
  globalFilteringFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
} from '@tanstack/react-table';
import { api } from '../../api';
import { getContactDisplayName } from '../../utils/pubkey';
import {
  measureElementWithFallback,
  observeElementRectWithFallback,
} from '../../utils/virtualization';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { toast } from '../ui/sonner';
import type { Contact } from '../../types';

const CONTACT_TYPE_LABELS: Record<number, string> = {
  0: 'Unknown',
  1: 'Client',
  2: 'Repeater',
  3: 'Room',
  4: 'Sensor',
};

interface ContactFilters {
  startDate: string;
  endDate: string;
  lastHeardAfter: string;
  lastHeardBefore: string;
  type: number | 'all';
}

const contactTableFeatures = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  rowSelectionFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

const contactColumns = [
  { id: 'select', header: '', enableSorting: false },
  {
    id: 'name',
    header: 'Name',
    accessorFn: (contact: Contact) =>
      getContactDisplayName(contact.name, contact.public_key, contact.last_advert).toLowerCase(),
    sortDescFirst: false,
  },
  { accessorKey: 'type', header: 'Type', sortDescFirst: true },
  { accessorKey: 'public_key', id: 'key', header: 'Key', sortDescFirst: false },
  {
    accessorFn: (contact: Contact) => contact.first_seen ?? 0,
    id: 'first_seen',
    header: 'Created',
    sortDescFirst: true,
  },
  {
    accessorFn: (contact: Contact) => contact.last_seen ?? 0,
    id: 'last_seen',
    header: 'Last heard',
    sortDescFirst: true,
  },
] satisfies Array<ColumnDef<typeof contactTableFeatures, Contact>>;

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function formatDateISO(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function datetimeToUnix(datetimeStr: string): number {
  const d = new Date(datetimeStr);
  return Math.floor(d.getTime() / 1000);
}

interface BulkDeleteContactsModalProps {
  open: boolean;
  onClose: () => void;
  contacts: Contact[];
  onDeleted: (deletedKeys: string[]) => void;
}

export function BulkDeleteContactsModal({
  open,
  onClose,
  contacts,
  onDeleted,
}: BulkDeleteContactsModalProps) {
  const selectionScrollRef = useRef<HTMLDivElement>(null);
  const confirmationScrollRef = useRef<HTMLDivElement>(null);
  const form = useForm({
    defaultValues: {
      step: 'select' as 'select' | 'confirm',
      startDate: '',
      endDate: '',
      lastHeardAfter: '',
      lastHeardBefore: '',
      typeFilter: 'all' as number | 'all',
    },
    onSubmit: async () => {
      const keysToDelete = table.getSelectedRowIds();
      try {
        const result = await api.bulkDeleteContacts(keysToDelete);
        const deletedLabel = `Deleted ${result.deleted} contact${result.deleted === 1 ? '' : 's'}`;
        if (result.radio_failed > 0) {
          toast.warning(deletedLabel, {
            description: `${result.radio_failed} could not be removed from the radio and may return during synchronization.`,
          });
        } else {
          toast.success(deletedLabel);
        }
        onDeleted(keysToDelete);
        resetAndClose();
      } catch (err) {
        console.error('Bulk delete failed:', err);
        toast.error('Bulk delete failed', {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    },
  });
  const values = useStore(form.store, (state) => state.values);
  const deleting = useStore(form.store, (state) => state.isSubmitting);
  const { step, startDate, endDate, lastHeardAfter, lastHeardBefore, typeFilter } = values;

  const filters = useMemo<ContactFilters>(
    () => ({ startDate, endDate, lastHeardAfter, lastHeardBefore, type: typeFilter }),
    [endDate, lastHeardAfter, lastHeardBefore, startDate, typeFilter]
  );
  const table = useTable({
    features: contactTableFeatures,
    columns: contactColumns,
    data: contacts,
    initialState: { sorting: [{ id: 'first_seen', desc: true }] },
    state: { globalFilter: filters },
    getRowId: (contact) => contact.public_key,
    enableRowSelection: true,
    enableRowRangeSelection: true,
    globalFilterFn: (row, _columnId, value: ContactFilters) => {
      const contact = row.original;
      if (value.type !== 'all' && contact.type !== value.type) return false;
      if (value.startDate && (contact.first_seen ?? 0) < datetimeToUnix(value.startDate))
        return false;
      if (value.endDate && (contact.first_seen ?? 0) > datetimeToUnix(value.endDate)) return false;
      if (value.lastHeardAfter && (contact.last_seen ?? 0) < datetimeToUnix(value.lastHeardAfter))
        return false;
      if (value.lastHeardBefore && (contact.last_seen ?? 0) > datetimeToUnix(value.lastHeardBefore))
        return false;
      return true;
    },
  });
  const filteredRows = table.getRowModel().rows;
  const filteredContacts = filteredRows.map((row) => row.original);
  const selectedKeys = new Set(table.getSelectedRowIds());

  const resetAndClose = useCallback(() => {
    form.reset();
    table.resetRowSelection(true);
    table.resetSorting();
    onClose();
  }, [form, onClose, table]);

  const handleSelectAll = () => {
    table.setRowSelection(Object.fromEntries(filteredRows.map((row) => [row.id, true] as const)));
  };

  const handleSelectNone = () => {
    table.resetRowSelection(true);
  };

  const selectedContacts = table.getSelectedRowModel().rows.map((row) => row.original);
  const confirmationTable = useTable({
    features: contactTableFeatures,
    columns: contactColumns.slice(1),
    data: selectedContacts,
  });
  const confirmationRows = confirmationTable.getRowModel().rows;
  const selectionVirtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => selectionScrollRef.current,
    estimateSize: () => 37,
    getItemKey: (index) => filteredRows[index]?.id ?? `contact-${index}`,
    overscan: 10,
    measureElement: measureElementWithFallback(() => 37),
    observeElementRect: observeElementRectWithFallback(420),
  });
  const confirmationVirtualizer = useVirtualizer({
    count: confirmationRows.length,
    getScrollElement: () => confirmationScrollRef.current,
    estimateSize: () => 37,
    getItemKey: (index) => confirmationRows[index]?.id ?? `confirmation-${index}`,
    overscan: 10,
    measureElement: measureElementWithFallback(() => 37),
    observeElementRect: observeElementRectWithFallback(420),
  });
  useEffect(() => {
    selectionVirtualizer.scrollToOffset(0);
  }, [filters, selectionVirtualizer]);

  const contactCount = selectedContacts.filter((c) => c.type === 1 || c.type === 0).length;
  const repeaterCount = selectedContacts.filter((c) => c.type === 2).length;
  const roomCount = selectedContacts.filter((c) => c.type === 3).length;
  const sensorCount = selectedContacts.filter((c) => c.type === 4).length;

  const firstSeenDates = selectedContacts.map((c) => c.first_seen ?? 0).filter((t) => t > 0);
  const minDate =
    firstSeenDates.length > 0 ? formatDateISO(Math.min(...firstSeenDates)) : 'unknown';
  const maxDate =
    firstSeenDates.length > 0 ? formatDateISO(Math.max(...firstSeenDates)) : 'unknown';

  const hasFilters = startDate || endDate || lastHeardAfter || lastHeardBefore;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && resetAndClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[85dvh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {step === 'select' ? 'Bulk Delete Contacts' : 'Confirm Deletion'}
          </DialogTitle>
          <DialogDescription>
            {step === 'select'
              ? 'Select contacts to delete. Message history will be preserved and accessible if a contact is re-added, but will no longer appear in the sidebar.'
              : 'Review the contacts that will be permanently deleted.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'select' && (
          <>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Show</label>
                  <select
                    value={typeFilter === 'all' ? 'all' : String(typeFilter)}
                    onChange={(e) =>
                      form.setFieldValue(
                        'typeFilter',
                        e.target.value === 'all' ? 'all' : Number(e.target.value)
                      )
                    }
                    className="block h-8 rounded-md border border-input bg-background px-2 text-sm"
                  >
                    <option value="all">All</option>
                    <option value="1">Clients</option>
                    <option value="2">Repeaters</option>
                    <option value="3">Room Servers</option>
                    <option value="4">Sensors</option>
                  </select>
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Created after</label>
                  <Input
                    type="datetime-local"
                    value={startDate}
                    onChange={(e) => form.setFieldValue('startDate', e.target.value)}
                    className="w-48 h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Created before</label>
                  <Input
                    type="datetime-local"
                    value={endDate}
                    onChange={(e) => form.setFieldValue('endDate', e.target.value)}
                    className="w-48 h-8 text-sm"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Last heard after</label>
                  <Input
                    type="datetime-local"
                    value={lastHeardAfter}
                    onChange={(e) => form.setFieldValue('lastHeardAfter', e.target.value)}
                    className="w-48 h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Last heard before</label>
                  <Input
                    type="datetime-local"
                    value={lastHeardBefore}
                    onChange={(e) => form.setFieldValue('lastHeardBefore', e.target.value)}
                    className="w-48 h-8 text-sm"
                  />
                </div>
              </div>
              <div className="flex gap-1.5">
                <Button type="button" variant="outline" size="sm" onClick={handleSelectAll}>
                  Select all
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={handleSelectNone}>
                  Select none
                </Button>
              </div>
            </div>

            <div className="text-xs text-muted-foreground">
              {filteredContacts.length} contact{filteredContacts.length === 1 ? '' : 's'} shown
              {hasFilters && ' (filtered)'}
              {' · '}
              {selectedKeys.size} selected
            </div>

            <div
              ref={selectionScrollRef}
              className="flex-1 overflow-y-auto min-h-0 border border-border rounded-md [contain:layout_paint]"
            >
              {filteredContacts.length === 0 ? (
                <div className="p-4 text-center text-sm text-muted-foreground">
                  No contacts match the selected filters.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/90 backdrop-blur-sm">
                    {table.getHeaderGroups().map((group) => (
                      <tr key={group.id} className="text-left text-xs text-muted-foreground">
                        {group.headers.map((header) => {
                          const sorted = header.column.getIsSorted();
                          return (
                            <th
                              key={header.id}
                              className={`px-3 py-1.5 ${header.id === 'select' ? 'w-8' : ''} ${header.id === 'type' || header.id === 'first_seen' || header.id === 'last_seen' ? 'hidden sm:table-cell' : ''} ${header.column.getCanSort() ? 'cursor-pointer select-none hover:text-foreground transition-colors' : ''}`}
                              onClick={header.column.getToggleSortingHandler()}
                              aria-sort={
                                sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : 'none'
                              }
                            >
                              <table.FlexRender header={header} />{' '}
                              {sorted ? (sorted === 'asc' ? '▲' : '▼') : ''}
                            </th>
                          );
                        })}
                      </tr>
                    ))}
                  </thead>
                  <tbody
                    className="relative block w-full"
                    style={{ height: selectionVirtualizer.getTotalSize() }}
                  >
                    {selectionVirtualizer.getVirtualItems().map((virtualRow) => {
                      const row = filteredRows[virtualRow.index];
                      if (!row) return null;
                      const c = row.original;
                      return (
                        <tr
                          key={virtualRow.key}
                          ref={selectionVirtualizer.measureElement}
                          data-index={virtualRow.index}
                          className="absolute left-0 top-0 table w-full table-fixed border-t border-border hover:bg-accent/50 cursor-pointer"
                          style={{ transform: `translateY(${virtualRow.start}px)` }}
                          onClick={row.getToggleSelectedHandler()}
                        >
                          <td className="px-3 py-1.5">
                            <input
                              type="checkbox"
                              checked={row.getIsSelected()}
                              onChange={row.getToggleSelectedHandler()}
                              onClick={(e) => e.stopPropagation()}
                              className="rounded border-input"
                            />
                          </td>
                          <td className="px-3 py-1.5 truncate max-w-[10rem]">
                            {getContactDisplayName(c.name, c.public_key, c.last_advert)}
                          </td>
                          <td className="px-3 py-1.5 hidden sm:table-cell text-xs text-muted-foreground">
                            {CONTACT_TYPE_LABELS[c.type] ?? 'Unknown'}
                          </td>
                          <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground truncate max-w-[8rem]">
                            {c.public_key.slice(0, 12)}
                          </td>
                          <td className="px-3 py-1.5 hidden sm:table-cell text-xs text-muted-foreground">
                            {c.first_seen ? formatDate(c.first_seen) : '—'}
                          </td>
                          <td className="px-3 py-1.5 hidden sm:table-cell text-xs text-muted-foreground">
                            {c.last_seen ? formatDate(c.last_seen) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={resetAndClose}>
                Cancel
              </Button>
              <Button
                variant="outline"
                className="border-warning text-warning hover:bg-warning/10 hover:text-warning"
                disabled={selectedKeys.size === 0}
                onClick={() => form.setFieldValue('step', 'confirm')}
              >
                Proceed to confirmation ({selectedKeys.size})
              </Button>
            </div>
          </>
        )}

        {step === 'confirm' && (
          <>
            <div
              ref={confirmationScrollRef}
              className="flex-1 overflow-y-auto min-h-0 border border-border rounded-md [contain:layout_paint]"
            >
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/90 backdrop-blur-sm">
                  {confirmationTable.getHeaderGroups().map((group) => (
                    <tr key={group.id} className="text-left text-xs text-muted-foreground">
                      {group.headers.map((header) => (
                        <th
                          key={header.id}
                          className={`px-3 py-1.5 ${header.id === 'first_seen' || header.id === 'last_seen' ? 'hidden sm:table-cell' : ''}`}
                        >
                          <confirmationTable.FlexRender header={header} />
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody
                  className="relative block w-full"
                  style={{ height: confirmationVirtualizer.getTotalSize() }}
                >
                  {confirmationVirtualizer.getVirtualItems().map((virtualRow) => {
                    const row = confirmationRows[virtualRow.index];
                    if (!row) return null;
                    const c = row.original;
                    return (
                      <tr
                        key={virtualRow.key}
                        ref={confirmationVirtualizer.measureElement}
                        data-index={virtualRow.index}
                        className="absolute left-0 top-0 table w-full table-fixed border-t border-border"
                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                      >
                        <td className="px-3 py-1.5 truncate max-w-[12rem]">
                          {getContactDisplayName(c.name, c.public_key, c.last_advert)}
                        </td>
                        <td className="px-3 py-1.5 text-xs text-muted-foreground">
                          {CONTACT_TYPE_LABELS[c.type] ?? 'Unknown'}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground truncate max-w-[8rem]">
                          {c.public_key.slice(0, 12)}
                        </td>
                        <td className="px-3 py-1.5 hidden sm:table-cell text-xs text-muted-foreground">
                          {c.first_seen ? formatDate(c.first_seen) : '—'}
                        </td>
                        <td className="px-3 py-1.5 hidden sm:table-cell text-xs text-muted-foreground">
                          {c.last_seen ? formatDate(c.last_seen) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-3 pt-2">
              <Button
                variant="destructive"
                className="w-full h-auto py-3 text-wrap"
                disabled={deleting}
                onClick={() => void form.handleSubmit()}
              >
                {deleting
                  ? 'Deleting...'
                  : `I confirm permanent, irrevocable deletion of all listed nodes above, totalling ${[
                      contactCount > 0 && `${contactCount} contact${contactCount === 1 ? '' : 's'}`,
                      repeaterCount > 0 &&
                        `${repeaterCount} repeater${repeaterCount === 1 ? '' : 's'}`,
                      roomCount > 0 && `${roomCount} room${roomCount === 1 ? '' : 's'}`,
                      sensorCount > 0 && `${sensorCount} sensor${sensorCount === 1 ? '' : 's'}`,
                    ]
                      .filter(Boolean)
                      .join(', ')}, spanning creation dates from ${minDate} to ${maxDate}`}
              </Button>
              <Button
                variant="secondary"
                onClick={() => form.setFieldValue('step', 'select')}
                disabled={deleting}
              >
                Back
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
