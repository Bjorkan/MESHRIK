import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { useSwipeable } from 'react-swipeable';

import { StatusBar } from './StatusBar';
import { Sidebar } from './Sidebar';
import { ConversationPane } from './ConversationPane';
import { NewMessageModal } from './NewMessageModal';
import { BulkAddChannelResultModal } from './BulkAddChannelResultModal';
import { CommandPalette } from './CommandPalette';
import { ShortcutHelpDialog } from './ShortcutHelpDialog';
import { SecurityWarningModal } from './SecurityWarningModal';
import { Toaster } from './ui/sonner';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import {
  SETTINGS_SECTION_ICONS,
  SETTINGS_SECTION_LABELS,
  SETTINGS_SECTION_ORDER,
  type SettingsSection,
} from './settings/settingsConstants';
import { getContrastTextColor, type LocalLabel } from '../utils/localLabel';
import type { CrackerPanelProps } from './CrackerPanel';
import type { SearchViewProps } from './SearchView';
import type { SettingsModalProps } from './SettingsModal';
import { cn } from '@/lib/utils';
import { useAppHotkeys } from '../hooks/useAppHotkeys';
import { usePagePinchZoomGuard } from '../hooks/usePagePinchZoomGuard';
import { LoadingIndicator } from './ui/loading-indicator';

const SettingsModal = lazy(() =>
  import('./SettingsModal').then((m) => ({ default: m.SettingsModal }))
);
const CrackerPanel = lazy(() =>
  import('./CrackerPanel').then((m) => ({ default: m.CrackerPanel }))
);
const SearchView = lazy(() => import('./SearchView').then((m) => ({ default: m.SearchView })));
const ContactInfoPane = lazy(() =>
  import('./ContactInfoPane').then((m) => ({ default: m.ContactInfoPane }))
);
const ChannelInfoPane = lazy(() =>
  import('./ChannelInfoPane').then((m) => ({ default: m.ChannelInfoPane }))
);

type SidebarProps = ComponentProps<typeof Sidebar>;
function LoadingInfoSheet({ title, onClose }: { title: string; onClose: () => void }) {
  useLingui();

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            <Trans>Preparing details</Trans>
          </SheetDescription>
        </SheetHeader>
        <LoadingIndicator label={t`Loading details...`} className="py-6" />
      </SheetContent>
    </Sheet>
  );
}
type ConversationPaneProps = ComponentProps<typeof ConversationPane>;
type NewMessageModalProps = Omit<ComponentProps<typeof NewMessageModal>, 'open' | 'onClose'>;
type BulkAddChannelResultModalProps = Omit<
  ComponentProps<typeof BulkAddChannelResultModal>,
  'open' | 'onClose'
>;
type ContactInfoPaneProps = ComponentProps<typeof ContactInfoPane>;
type ChannelInfoPaneProps = ComponentProps<typeof ChannelInfoPane>;

interface AppShellProps {
  localLabel: LocalLabel;
  showNewMessage: boolean;
  showBulkAddResults: boolean;
  showSettings: boolean;
  settingsSection: SettingsSection;
  sidebarOpen: boolean;
  showCracker: boolean;
  disabledSettingsSections?: SettingsSection[];
  onSettingsSectionChange: (section: SettingsSection) => void;
  onOpenSettingsSection: (section: SettingsSection) => void;
  onSidebarOpenChange: (open: boolean) => void;
  onCrackerRunningChange: (running: boolean) => void;
  onToggleSettingsView: () => void;
  onCloseSettingsView: () => void;
  onCloseNewMessage: () => void;
  onCloseBulkAddResults: () => void;
  onLocalLabelChange: (label: LocalLabel) => void;
  statusProps: Pick<ComponentProps<typeof StatusBar>, 'health' | 'config'>;
  sidebarProps: SidebarProps;
  conversationPaneProps: ConversationPaneProps;
  searchProps: SearchViewProps;
  settingsProps: Omit<
    SettingsModalProps,
    'open' | 'pageMode' | 'externalSidebarNav' | 'desktopSection' | 'onClose' | 'onLocalLabelChange'
  >;
  crackerProps: Omit<CrackerPanelProps, 'visible' | 'onRunningChange'>;
  newMessageModalProps: NewMessageModalProps;
  bulkAddChannelResultModalProps: BulkAddChannelResultModalProps;
  contactInfoPaneProps: ContactInfoPaneProps;
  channelInfoPaneProps: ChannelInfoPaneProps;
  onRepeaterAutoLogin: (publicKey: string, displayName: string) => void;
}

export function AppShell({
  localLabel,
  showNewMessage,
  showBulkAddResults,
  showSettings,
  settingsSection,
  sidebarOpen,
  showCracker,
  disabledSettingsSections = [],
  onSettingsSectionChange,
  onOpenSettingsSection,
  onSidebarOpenChange,
  onCrackerRunningChange,
  onToggleSettingsView,
  onCloseSettingsView,
  onCloseNewMessage,
  onCloseBulkAddResults,
  onLocalLabelChange,
  statusProps,
  sidebarProps,
  conversationPaneProps,
  searchProps,
  settingsProps,
  crackerProps,
  newMessageModalProps,
  bulkAddChannelResultModalProps,
  contactInfoPaneProps,
  channelInfoPaneProps,
  onRepeaterAutoLogin,
}: AppShellProps) {
  useLingui();

  usePagePinchZoomGuard();

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [searchFocusRequestVersion, setSearchFocusRequestVersion] = useState(0);
  const { onSelectConversation } = sidebarProps;
  const hasBlockingOverlay =
    showNewMessage ||
    showBulkAddResults ||
    contactInfoPaneProps.contactKey !== null ||
    channelInfoPaneProps.channelKey !== null;
  const openMessageSearch = useCallback(() => {
    onSelectConversation({
      type: 'search',
      id: 'search',
      name: 'Message Search',
    });
    setSearchFocusRequestVersion((version) => version + 1);
  }, [onSelectConversation]);
  const openMap = useCallback(
    () =>
      onSelectConversation({
        type: 'map',
        id: 'map',
        name: 'Node Map',
      }),
    [onSelectConversation]
  );
  const openRadioActivity = useCallback(
    () =>
      onSelectConversation({
        type: 'radio-activity',
        id: 'radio-activity',
        name: 'Radio Activity',
      }),
    [onSelectConversation]
  );
  useAppHotkeys({
    commandPaletteEnabled:
      commandPaletteOpen || (!hasBlockingOverlay && !shortcutHelpOpen && !sidebarOpen),
    navigationEnabled:
      !hasBlockingOverlay && !commandPaletteOpen && !shortcutHelpOpen && !sidebarOpen,
    shortcutHelpEnabled:
      shortcutHelpOpen || (!hasBlockingOverlay && !commandPaletteOpen && !sidebarOpen),
    onToggleCommandPalette: () => setCommandPaletteOpen((current) => !current),
    onOpenShortcutHelp: () => setShortcutHelpOpen(true),
    onOpenMessageSearch: openMessageSearch,
    onOpenMap: openMap,
    onOpenRadioActivity: openRadioActivity,
  });

  const swipeHandlers = useSwipeable({
    onSwipedRight: ({ initial }) => {
      if (initial[0] < 30 && !sidebarOpen && window.innerWidth < 768) {
        onSidebarOpenChange(true);
      }
    },
    trackTouch: true,
    trackMouse: false,
    preventScrollOnSwipe: true,
  });

  const closeSwipeHandlers = useSwipeable({
    onSwipedLeft: () => onSidebarOpenChange(false),
    trackTouch: true,
    trackMouse: false,
    preventScrollOnSwipe: false,
  });

  const handleOpenSettings = useCallback(
    (section: SettingsSection) => {
      onOpenSettingsSection(section);
    },
    [onOpenSettingsSection]
  );

  const searchMounted = useRef(false);
  const navigationTitleRef = useRef<HTMLHeadingElement>(null);
  if (conversationPaneProps.activeConversation?.type === 'search') {
    searchMounted.current = true;
  }

  const crackerMounted = useRef(false);
  if (showCracker) {
    crackerMounted.current = true;
  }

  // Position toasts below the conversation header when in chat, otherwise below the status bar
  const TOAST_TOP_PADDING = 10;
  const [toastTopOffset, setToastTopOffset] = useState<number | undefined>(undefined);
  const hasLocalLabel = !!localLabel.text;
  const activeType = conversationPaneProps.activeConversation?.type;
  const activeId = conversationPaneProps.activeConversation?.id;
  useEffect(() => {
    const measure = () => {
      const anchor =
        document.querySelector('[data-toast-anchor="conversation"]') ??
        document.querySelector('[data-toast-anchor="statusbar"]');
      setToastTopOffset(
        anchor ? anchor.getBoundingClientRect().top + TOAST_TOP_PADDING : undefined
      );
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [hasLocalLabel, activeType, activeId, showSettings]);

  const settingsSidebarContent = (
    <nav
      className="sidebar w-60 h-full min-h-0 overflow-hidden bg-card border-r border-border flex flex-col"
      aria-label={t`Settings`}
    >
      <div className="flex justify-between items-center px-3 py-2.5 border-b border-border">
        <h2 className="text-[0.625rem] uppercase tracking-wider text-muted-foreground font-medium">
          <Trans>Settings</Trans>
        </h2>
        <button
          type="button"
          onClick={onCloseSettingsView}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-status-connected/15 border border-status-connected/30 text-status-connected hover:bg-status-connected/25 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={t`Back to conversations`}
          aria-label={t`Back to conversations`}
        >
          <Trans>&larr; Back to Chat</Trans>
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto py-1 [contain:layout_paint]">
        {SETTINGS_SECTION_ORDER.map((section) => {
          const Icon = SETTINGS_SECTION_ICONS[section];
          const disabled = disabledSettingsSections.includes(section);
          return (
            <button
              key={section}
              type="button"
              disabled={disabled}
              className={cn(
                'w-full px-3 py-2 text-left text-[0.8125rem] border-l-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50',
                !disabled && 'hover:bg-accent',
                settingsSection === section && !disabled && 'bg-accent border-l-primary'
              )}
              aria-current={settingsSection === section ? `true` : undefined}
              onClick={() => onSettingsSectionChange(section)}
            >
              <span className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <span>{SETTINGS_SECTION_LABELS[section]}</span>
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );

  const activeSidebarContent = showSettings ? (
    settingsSidebarContent
  ) : (
    <Sidebar {...sidebarProps} />
  );

  return (
    <div className="flex flex-col h-full" {...swipeHandlers}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-2 focus:bg-primary focus:text-primary-foreground"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        <Trans>Skip to content</Trans>
      </a>
      {localLabel.text && (
        <div
          style={{
            backgroundColor: localLabel.color,
            color: getContrastTextColor(localLabel.color),
          }}
          className="px-4 py-1 text-center text-sm font-medium"
        >
          {localLabel.text}
        </div>
      )}

      <StatusBar
        health={statusProps.health}
        config={statusProps.config}
        settingsMode={showSettings}
        onSettingsClick={onToggleSettingsView}
        onMenuClick={showSettings ? undefined : () => onSidebarOpenChange(true)}
      />
      <div data-toast-anchor="statusbar" aria-hidden="true" />

      <div className="flex flex-1 overflow-hidden">
        <div className="hidden md:block min-h-0 overflow-hidden">{activeSidebarContent}</div>

        <Sheet open={sidebarOpen} onOpenChange={onSidebarOpenChange}>
          <SheetContent
            side="left"
            className="w-[280px] p-0 flex flex-col"
            hideCloseButton
            initialFocusRef={navigationTitleRef}
          >
            <SheetHeader className="sr-only">
              <SheetTitle asChild>
                <h2 ref={navigationTitleRef} tabIndex={-1}>
                  <Trans>Navigation</Trans>
                </h2>
              </SheetTitle>
              <SheetDescription>
                <Trans>Sidebar navigation</Trans>
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-hidden" {...closeSwipeHandlers}>
              {activeSidebarContent}
            </div>
          </SheetContent>
        </Sheet>

        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 flex flex-col bg-background min-w-0"
        >
          <div
            className={cn(
              'flex-1 flex flex-col min-h-0',
              (showSettings || conversationPaneProps.activeConversation?.type === 'search') &&
                'hidden'
            )}
          >
            <ConversationPane {...conversationPaneProps} />
          </div>

          {searchMounted.current && (
            <div
              className={cn(
                'flex-1 flex flex-col min-h-0',
                (conversationPaneProps.activeConversation?.type !== 'search' || showSettings) &&
                  'hidden'
              )}
            >
              <Suspense
                fallback={
                  <div className="flex-1 flex items-center justify-center text-muted-foreground">
                    <LoadingIndicator label={t`Loading search...`} />
                  </div>
                }
              >
                <SearchView
                  {...searchProps}
                  focusRequestVersion={searchFocusRequestVersion}
                  visible={
                    conversationPaneProps.activeConversation?.type === 'search' && !showSettings
                  }
                />
              </Suspense>
            </div>
          )}

          {showSettings && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex-1 min-h-0 overflow-hidden">
                <Suspense
                  fallback={
                    <div className="flex-1 flex items-center justify-center p-8 text-muted-foreground">
                      <LoadingIndicator label={t`Loading settings...`} />
                    </div>
                  }
                >
                  <SettingsModal
                    {...settingsProps}
                    open={showSettings}
                    pageMode
                    externalSidebarNav
                    desktopSection={settingsSection}
                    onClose={onCloseSettingsView}
                    onLocalLabelChange={onLocalLabelChange}
                  />
                </Suspense>
              </div>
            </div>
          )}
        </main>
      </div>

      <div
        className={cn(
          'border-t border-border bg-background transition-all duration-200 overflow-hidden',
          showCracker ? 'h-[275px]' : 'h-0'
        )}
      >
        {crackerMounted.current && (
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <LoadingIndicator label={t`Loading channel finder...`} />
              </div>
            }
          >
            <CrackerPanel
              {...crackerProps}
              visible={showCracker}
              onRunningChange={onCrackerRunningChange}
            />
          </Suspense>
        )}
      </div>

      <NewMessageModal
        {...newMessageModalProps}
        open={showNewMessage}
        onClose={onCloseNewMessage}
      />
      <BulkAddChannelResultModal
        {...bulkAddChannelResultModalProps}
        open={showBulkAddResults}
        onClose={onCloseBulkAddResults}
      />

      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        contacts={sidebarProps.contacts}
        channels={sidebarProps.channels}
        onSelectConversation={onSelectConversation}
        onOpenSettings={handleOpenSettings}
        onOpenShortcutHelp={() => setShortcutHelpOpen(true)}
        onRepeaterAutoLogin={onRepeaterAutoLogin}
      />
      <ShortcutHelpDialog open={shortcutHelpOpen} onOpenChange={setShortcutHelpOpen} />
      <SecurityWarningModal health={statusProps.health} />
      {contactInfoPaneProps.contactKey !== null && (
        <Suspense
          fallback={
            <LoadingInfoSheet title={t`Contact Info`} onClose={contactInfoPaneProps.onClose} />
          }
        >
          <ContactInfoPane {...contactInfoPaneProps} />
        </Suspense>
      )}
      {channelInfoPaneProps.channelKey !== null && (
        <Suspense
          fallback={
            <LoadingInfoSheet title={t`Channel Info`} onClose={channelInfoPaneProps.onClose} />
          }
        >
          <ChannelInfoPane {...channelInfoPaneProps} />
        </Suspense>
      )}
      <Toaster
        position="top-right"
        offset={toastTopOffset !== undefined ? { top: toastTopOffset } : undefined}
        mobileOffset={toastTopOffset !== undefined ? { top: toastTopOffset } : undefined}
      />
    </div>
  );
}
