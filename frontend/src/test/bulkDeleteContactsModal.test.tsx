import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BulkDeleteContactsModal } from '../components/settings/BulkDeleteContactsModal';
import type { Contact } from '../types';

const mocks = vi.hoisted(() => ({
  bulkDeleteContacts: vi.fn(),
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../api', () => ({
  api: { bulkDeleteContacts: mocks.bulkDeleteContacts },
}));

vi.mock('../components/ui/sonner', () => ({ toast: mocks.toast }));

function makeContact(index: number, overrides: Partial<Contact> = {}): Contact {
  return {
    public_key: index.toString(16).padStart(64, '0'),
    name: `Node ${index.toString().padStart(5, '0')}`,
    type: index % 2 === 0 ? 2 : 1,
    flags: 0,
    direct_path: null,
    direct_path_len: -1,
    direct_path_hash_mode: 0,
    last_advert: null,
    lat: null,
    lon: null,
    last_seen: 1700000000 + index,
    on_radio: false,
    favorite: false,
    last_contacted: null,
    last_read_at: null,
    first_seen: 1600000000 + index,
    ...overrides,
  };
}

function renderModal(contacts: Contact[]) {
  const onClose = vi.fn();
  const onDeleted = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const renderDialog = (nextContacts: Contact[]) => (
    <QueryClientProvider client={queryClient}>
      <BulkDeleteContactsModal
        open
        contacts={nextContacts}
        onClose={onClose}
        onDeleted={onDeleted}
      />
    </QueryClientProvider>
  );
  const view = render(renderDialog(contacts));
  return {
    ...view,
    rerenderContacts: (nextContacts: Contact[]) => view.rerender(renderDialog(nextContacts)),
    onClose,
    onDeleted,
  };
}

async function rowCheckbox(name: string): Promise<HTMLElement> {
  const row = (await screen.findByText(name)).closest('tr');
  if (!row) throw new Error(`Missing table row for ${name}`);
  return within(row).getByRole('checkbox');
}

describe('BulkDeleteContactsModal TanStack Table state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bulkDeleteContacts.mockResolvedValue({
      deleted: 1,
      radio_deleted: 1,
      radio_failed: 0,
      failed_keys: [],
    });
  });

  it('submits exactly the stable IDs frozen in confirmation across filter and DB updates', async () => {
    const alice = makeContact(1, { name: 'Alice', type: 1 });
    const bob = makeContact(2, { name: 'Bob', type: 2 });
    const carol = makeContact(3, { name: 'Carol', type: 2 });
    const view = renderModal([alice, bob]);

    fireEvent.click(await rowCheckbox('Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'ascending'
    );

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
    view.rerenderContacts([{ ...alice, name: 'Alice updated' }, bob, carol]);
    expect(screen.getByText(/2 contacts shown \(filtered\)/)).toBeInTheDocument();
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'ascending'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Proceed to confirmation (1)' }));
    expect(screen.getByRole('heading', { name: 'Confirm Deletion' })).toBeInTheDocument();
    expect(screen.getByText('Alice updated')).toBeInTheDocument();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
    expect(screen.queryByText('Carol')).not.toBeInTheDocument();

    view.rerenderContacts([bob, carol, makeContact(4, { name: 'Dave', type: 2 })]);
    expect(screen.getByText('Alice updated')).toBeInTheDocument();
    expect(screen.queryByText('Dave')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /I confirm permanent/ }));
    await waitFor(() => expect(mocks.bulkDeleteContacts).toHaveBeenCalledWith([alice.public_key]));
    expect(view.onDeleted).toHaveBeenCalledWith([alice.public_key]);
  });

  it('reports partial radio deletion without losing the successful database result', async () => {
    const alice = makeContact(1, { name: 'Alice' });
    mocks.bulkDeleteContacts.mockResolvedValue({
      deleted: 1,
      radio_deleted: 0,
      radio_failed: 1,
      failed_keys: [alice.public_key],
    });
    const view = renderModal([alice]);

    fireEvent.click(await rowCheckbox('Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Proceed to confirmation (1)' }));
    fireEvent.click(screen.getByRole('button', { name: /I confirm permanent/ }));

    await waitFor(() => {
      expect(mocks.toast.warning).toHaveBeenCalledWith('Deleted 1 contact', {
        description: '1 could not be removed from the radio and may return during synchronization.',
      });
    });
    expect(view.onDeleted).toHaveBeenCalledWith([alice.public_key]);
  });

  it('keeps destructive confirmation open when the server rejects deletion', async () => {
    const alice = makeContact(1, { name: 'Alice' });
    mocks.bulkDeleteContacts.mockRejectedValue(new Error('Radio disconnected'));
    const view = renderModal([alice]);

    fireEvent.click(await rowCheckbox('Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Proceed to confirmation (1)' }));
    fireEvent.click(screen.getByRole('button', { name: /I confirm permanent/ }));

    await waitFor(() => {
      expect(mocks.toast.error).toHaveBeenCalledWith('Bulk delete failed', {
        description: 'Radio disconnected',
      });
    });
    expect(screen.getByRole('heading', { name: 'Confirm Deletion' })).toBeInTheDocument();
    expect(view.onDeleted).not.toHaveBeenCalled();
  });

  it.each([100, 1000, 5000])(
    'keeps sorting, filtering and stable selection coherent for %i rows',
    async (rowCount) => {
      const contacts = Array.from({ length: rowCount }, (_, index) => makeContact(index + 1));
      renderModal(contacts);

      expect(screen.getByText(new RegExp(`${rowCount} contacts shown`))).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
      expect(screen.getByText(new RegExp(`${rowCount} selected`))).toBeInTheDocument();

      fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
      expect(
        screen.getByText(new RegExp(`${rowCount / 2} contacts shown \\(filtered\\)`))
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Name' }));
      expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
        'aria-sort',
        'ascending'
      );
      expect(screen.getByText(new RegExp(`${rowCount} selected`))).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole('button', { name: `Proceed to confirmation (${rowCount})` })
      );
      expect(screen.getByRole('heading', { name: 'Confirm Deletion' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(screen.getByText(new RegExp(`${rowCount} selected`))).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
        'aria-sort',
        'ascending'
      );
    },
    15_000
  );

  it('resets non-persistent filters, sorting and selection after a remount', () => {
    const contacts = Array.from({ length: 100 }, (_, index) => makeContact(index + 1));
    const first = renderModal(contacts);
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    first.unmount();

    renderModal(contacts);
    expect(screen.getByRole('combobox')).toHaveValue('all');
    expect(screen.getByText(/0 selected/)).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByRole('columnheader', { name: /Created/ })).toHaveAttribute(
      'aria-sort',
      'descending'
    );
  });

  it('keeps the semantic empty state instead of rendering an empty table', () => {
    renderModal([]);
    expect(screen.getByText('No contacts match the selected filters.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
