import { useCallback, useEffect, useRef } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { Dice5 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Checkbox } from './ui/checkbox';
import { Button } from './ui/button';

type Tab = 'new-contact' | 'new-channel' | 'hashtag' | 'bulk-hashtag';

interface BulkParseResult {
  channelNames: string[];
  invalidNames: string[];
}

interface NewMessageModalProps {
  open: boolean;
  undecryptedCount: number;
  showBulkAddChannelTab?: boolean;
  prefillRequest?: {
    tab: 'hashtag';
    hashtagName: string;
    nonce: number;
  } | null;
  onClose: () => void;
  onCreateContact: (
    name: string,
    publicKey: string,
    tryHistorical: boolean,
    type?: number
  ) => Promise<void>;
  onCreateChannel: (name: string, key: string, tryHistorical: boolean) => Promise<void>;
  onCreateHashtagChannel: (name: string, tryHistorical: boolean) => Promise<void>;
  onBulkAddHashtagChannels: (channelNames: string[], tryHistorical: boolean) => Promise<void>;
}

function validateHashtagName(channelName: string, permitExtended: boolean): string | null {
  if (!channelName) {
    return 'Channel name is required';
  }
  // The on-radio channel name field holds 32 UTF-8 bytes including the leading '#'.
  if (new TextEncoder().encode(`#${channelName}`).length > 32) {
    return 'Channel name is too long (max 32 bytes including #)';
  }
  if (permitExtended) {
    // Hashed verbatim, matching meshcore_py / meshcore-cli / meshcore.js — any character
    // (capitals, whitespace, '&', accents, …) yields a valid SHA256-derived key.
    return null;
  }
  if (!/^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$/.test(channelName)) {
    return 'Use letters, numbers, and single dashes (no leading/trailing dashes)';
  }
  return null;
}

function parseBulkHashtagNames(rawText: string, permitExtended: boolean): BulkParseResult {
  // When extended names are permitted, whitespace can be part of a name, so split on
  // newlines/commas only. Otherwise keep the whitespace-delimited behavior.
  const tokens = rawText
    .split(permitExtended ? /[\n,]+/ : /[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const invalidNames: string[] = [];
  const channelNames: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const stripped = token.replace(/^#+/, '');
    const validationError = validateHashtagName(stripped, permitExtended);
    if (validationError) {
      invalidNames.push(token);
      continue;
    }

    const normalized = permitExtended ? stripped : stripped.toLowerCase();
    const channelName = `#${normalized}`;
    if (seen.has(channelName)) {
      continue;
    }
    seen.add(channelName);
    channelNames.push(channelName);
  }

  return { channelNames, invalidNames };
}

export function NewMessageModal({
  open,
  undecryptedCount,
  showBulkAddChannelTab = false,
  prefillRequest = null,
  onClose,
  onCreateContact,
  onCreateChannel,
  onCreateHashtagChannel,
  onBulkAddHashtagChannels,
}: NewMessageModalProps) {
  const hashtagInputRef = useRef<HTMLInputElement>(null);
  const bulkTextareaRef = useRef<HTMLTextAreaElement>(null);
  const form = useForm({
    defaultValues: {
      tab: 'new-contact' as Tab,
      name: '',
      contactType: 1,
      contactKey: '',
      channelKey: '',
      bulkChannelText: '',
      tryHistorical: false,
      permitExtended: false,
      serverError: '',
      addAnother: false,
    },
    onSubmit: async ({ value }) => {
      form.setFieldValue('serverError', '');
      try {
        if (value.tab === 'new-contact') {
          if (!value.name.trim() || !value.contactKey.trim()) {
            form.setFieldValue('serverError', 'Name and public key are required');
            return;
          }
          await onCreateContact(
            value.name.trim(),
            value.contactKey.trim(),
            value.tryHistorical,
            value.contactType
          );
        } else if (value.tab === 'new-channel') {
          if (!value.name.trim() || !value.channelKey.trim()) {
            form.setFieldValue('serverError', 'Channel name and key are required');
            return;
          }
          await onCreateChannel(value.name.trim(), value.channelKey.trim(), value.tryHistorical);
        } else if (value.tab === 'hashtag') {
          const channelName = value.name.trim();
          const validationError = validateHashtagName(channelName, value.permitExtended);
          if (validationError) {
            form.setFieldValue('serverError', validationError);
            return;
          }
          const normalizedName = value.permitExtended ? channelName : channelName.toLowerCase();
          await onCreateHashtagChannel(`#${normalizedName}`, value.tryHistorical);
        } else {
          const { channelNames, invalidNames } = parseBulkHashtagNames(
            value.bulkChannelText,
            value.permitExtended
          );
          if (channelNames.length === 0) {
            form.setFieldValue('serverError', 'Enter at least one valid channel name');
            return;
          }
          if (invalidNames.length > 0) {
            form.setFieldValue('serverError', `Invalid channel names: ${invalidNames.join(', ')}`);
            return;
          }
          await onBulkAddHashtagChannels(channelNames, value.tryHistorical);
        }

        if (value.addAnother && value.tab === 'hashtag') {
          form.setFieldValue('name', '');
          form.setFieldValue('addAnother', false);
          hashtagInputRef.current?.focus();
          return;
        }

        form.reset();
        onClose();
      } catch (err) {
        form.setFieldValue('serverError', err instanceof Error ? err.message : 'Failed to create');
      }
    },
  });
  const formRef = useRef(form);
  formRef.current = form;
  const values = useStore(form.store, (state) => state.values);
  const loading = useStore(form.store, (state) => state.isSubmitting);
  const {
    tab,
    name,
    contactType,
    contactKey,
    channelKey,
    bulkChannelText,
    tryHistorical,
    permitExtended,
    serverError: error,
  } = values;

  const resetForm = useCallback((nextTab?: Tab) => {
    const currentForm = formRef.current;
    const targetTab = nextTab ?? currentForm.state.values.tab;
    currentForm.reset();
    currentForm.setFieldValue('tab', targetTab);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    if (prefillRequest) {
      resetForm(prefillRequest.tab);
      formRef.current.setFieldValue('name', prefillRequest.hashtagName);
      requestAnimationFrame(() => {
        hashtagInputRef.current?.focus();
      });
      return;
    }

    if (showBulkAddChannelTab) {
      resetForm('bulk-hashtag');
      requestAnimationFrame(() => {
        bulkTextareaRef.current?.focus();
      });
      return;
    }

    resetForm('new-contact');
  }, [open, prefillRequest, resetForm, showBulkAddChannelTab]);

  const handleCreate = () => {
    form.setFieldValue('addAnother', false);
    void form.handleSubmit();
  };

  const handleCreateAndAddAnother = () => {
    form.setFieldValue('addAnother', true);
    void form.handleSubmit();
  };

  const showHistoricalOption = undecryptedCount > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !loading) {
          resetForm();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>New Conversation</DialogTitle>
          <DialogDescription className="sr-only">
            {tab === 'new-contact' && 'Add a new contact by entering their name and public key'}
            {tab === 'new-channel' && 'Create a private channel with a shared encryption key'}
            {tab === 'hashtag' && 'Join a public hashtag channel'}
            {tab === 'bulk-hashtag' && 'Paste multiple hashtag channels to add them in one batch'}
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => {
            resetForm(value as Tab);
          }}
          className="w-full"
        >
          <TabsList
            className={
              showBulkAddChannelTab
                ? 'grid h-auto min-h-10 w-full grid-cols-2 sm:grid-cols-4'
                : 'grid h-auto min-h-10 w-full grid-cols-2 sm:grid-cols-3'
            }
          >
            <TabsTrigger
              value="new-contact"
              className="min-h-10 whitespace-normal py-2 text-center leading-tight"
            >
              Contact
            </TabsTrigger>
            <TabsTrigger
              value="new-channel"
              className="min-h-10 whitespace-normal py-2 text-center leading-tight"
            >
              Private Channel
            </TabsTrigger>
            <TabsTrigger
              value="hashtag"
              className="min-h-10 whitespace-normal py-2 text-center leading-tight"
            >
              Hashtag Channel
            </TabsTrigger>
            {showBulkAddChannelTab && (
              <TabsTrigger
                value="bulk-hashtag"
                className="min-h-10 whitespace-normal py-2 text-center leading-tight"
              >
                Bulk Add Channel
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="new-contact" className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="contact-name">Name</Label>
              <Input
                id="contact-name"
                value={name}
                onChange={(e) => form.setFieldValue('name', e.target.value)}
                placeholder="Contact name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contact-key">Public Key</Label>
              <Input
                id="contact-key"
                value={contactKey}
                onChange={(e) => form.setFieldValue('contactKey', e.target.value)}
                placeholder="64-character hex public key"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contact-type">Type</Label>
              <select
                id="contact-type"
                value={contactType}
                onChange={(e) => form.setFieldValue('contactType', Number(e.target.value))}
                className="block h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs"
              >
                <option value={1}>Client</option>
                <option value={2}>Repeater</option>
                <option value={3}>Room Server</option>
              </select>
            </div>
          </TabsContent>

          <TabsContent value="new-channel" className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="channel-name">Channel Name</Label>
              <Input
                id="channel-name"
                value={name}
                onChange={(e) => form.setFieldValue('name', e.target.value)}
                placeholder="Channel name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="channel-key">Channel Key</Label>
              <div className="flex gap-2">
                <Input
                  id="channel-key"
                  value={channelKey}
                  onChange={(e) => form.setFieldValue('channelKey', e.target.value)}
                  placeholder="Pre-shared key (hex)"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    const bytes = new Uint8Array(16);
                    crypto.getRandomValues(bytes);
                    const hex = Array.from(bytes)
                      .map((byte) => byte.toString(16).padStart(2, '0'))
                      .join('');
                    form.setFieldValue('channelKey', hex);
                  }}
                  title="Generate random key"
                  aria-label="Generate random key"
                >
                  <Dice5 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="hashtag" className="mt-4">
            <div className="space-y-2">
              <Label htmlFor="hashtag-name">Hashtag Channel</Label>
              <div className="flex items-center gap-1">
                <span className="text-sm text-muted-foreground">#</span>
                <Input
                  ref={hashtagInputRef}
                  id="hashtag-name"
                  value={name}
                  onChange={(e) => form.setFieldValue('name', e.target.value)}
                  placeholder="channel-name"
                  className="flex-1"
                />
              </div>
            </div>
            <div className="mt-3 space-y-1">
              <label className="flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={permitExtended}
                  onChange={(e) => form.setFieldValue('permitExtended', e.target.checked)}
                  className="h-4 w-4 rounded border-input accent-primary"
                />
                <span className="text-sm">
                  Permit capitals, whitespace, and extended characters
                </span>
              </label>
              <p className="pl-7 text-xs text-muted-foreground">
                Off normalizes to lowercase letters, numbers, and dashes. On hashes the name exactly
                as typed — matches other MeshCore clients and lets you join channels with capitals,
                spaces, or symbols like &amp;.
              </p>
            </div>
          </TabsContent>

          {showBulkAddChannelTab && (
            <TabsContent value="bulk-hashtag" className="mt-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="bulk-hashtag-names">Bulk Add Channel</Label>
                <textarea
                  ref={bulkTextareaRef}
                  id="bulk-hashtag-names"
                  aria-label="Bulk channel names"
                  value={bulkChannelText}
                  onChange={(e) => form.setFieldValue('bulkChannelText', e.target.value)}
                  placeholder={'#ops\nmesh-chat\nanother-channel'}
                  className="min-h-48 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-hidden transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
                <p className="text-xs text-muted-foreground">
                  {permitExtended
                    ? 'One channel name per line (or comma-separated); spaces are kept as part of the name. Leading # marks are stripped automatically.'
                    : 'Paste channel names separated by lines, spaces, or commas. Leading # marks are stripped automatically.'}
                </p>
              </div>
              <div className="space-y-1">
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={permitExtended}
                    onChange={(e) => form.setFieldValue('permitExtended', e.target.checked)}
                    className="h-4 w-4 rounded border-input accent-primary"
                  />
                  <span className="text-sm">
                    Permit capitals, whitespace, and extended characters
                  </span>
                </label>
                <p className="pl-7 text-xs text-muted-foreground">
                  Off normalizes to lowercase letters, numbers, and dashes. On hashes each name
                  exactly as typed — matches other MeshCore clients and lets you join channels with
                  capitals, spaces, or symbols like &amp;.
                </p>
              </div>
            </TabsContent>
          )}
        </Tabs>

        {tab !== 'new-contact' && (
          <p className="text-xs text-muted-foreground" role="note">
            Creating a channel saves it to the app database only. It is written to a radio slot when
            needed for sending; creation itself does not change the radio.
          </p>
        )}

        {showHistoricalOption && (
          <div className="space-y-1">
            <div className="flex items-center justify-end space-x-2">
              <Label
                htmlFor="try-historical"
                className="cursor-pointer text-sm text-muted-foreground"
              >
                Try decrypting {undecryptedCount.toLocaleString()} stored packet
                {undecryptedCount !== 1 ? 's' : ''}
              </Label>
              <Checkbox
                id="try-historical"
                checked={tryHistorical}
                onCheckedChange={(checked) => form.setFieldValue('tryHistorical', checked === true)}
              />
            </div>
            {tryHistorical && (
              <p className="text-right text-xs text-muted-foreground">
                Messages will stream in as they decrypt in the background
              </p>
            )}
          </div>
        )}

        {error && (
          <div className="text-sm text-destructive" role="alert">
            {error}
          </div>
        )}

        {loading && (
          <p className="text-sm text-muted-foreground" role="status">
            Creation is in progress. This dialog will stay open until the request finishes.
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => {
              resetForm();
              onClose();
            }}
          >
            Cancel
          </Button>
          {tab === 'hashtag' && (
            <Button variant="secondary" onClick={handleCreateAndAddAnother} disabled={loading}>
              {loading ? 'Creating...' : 'Create & Add Another'}
            </Button>
          )}
          <Button onClick={handleCreate} disabled={loading}>
            {loading
              ? tab === 'bulk-hashtag'
                ? 'Adding...'
                : 'Creating...'
              : tab === 'bulk-hashtag'
                ? 'Add Channels'
                : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
