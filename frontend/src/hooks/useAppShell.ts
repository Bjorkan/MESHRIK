import { useCallback, useEffect, useState } from 'react';

import { getLocalLabel, type LocalLabel } from '../utils/localLabel';
import { getSavedDistanceUnit, type DistanceUnit } from '../utils/distanceUnits';
import { getSavedRenderRichPayloads } from '../utils/richPayloadPreference';
import { getSavedShowPathHopWidth } from '../utils/pathHopWidthPreference';
import type { SettingsSection } from '../components/settings/settingsConstants';

interface UseAppShellOptions {
  routeSettingsSection?: SettingsSection | null;
  onNavigateSettings?: (section: SettingsSection) => void;
  onCloseSettingsRoute?: () => void;
}

interface UseAppShellResult {
  showNewMessage: boolean;
  showSettings: boolean;
  settingsSection: SettingsSection;
  sidebarOpen: boolean;
  showCracker: boolean;
  crackerRunning: boolean;
  localLabel: LocalLabel;
  distanceUnit: DistanceUnit;
  renderRichPayloads: boolean;
  showPathHopWidth: boolean;
  setSettingsSection: (section: SettingsSection) => void;
  setSidebarOpen: (open: boolean) => void;
  setCrackerRunning: (running: boolean) => void;
  setLocalLabel: (label: LocalLabel) => void;
  setDistanceUnit: (unit: DistanceUnit) => void;
  setRenderRichPayloads: (enabled: boolean) => void;
  setShowPathHopWidth: (enabled: boolean) => void;
  handleCloseSettingsView: () => void;
  handleToggleSettingsView: () => void;
  handleOpenSettingsSection: (section: SettingsSection) => void;
  handleOpenNewMessage: () => void;
  handleCloseNewMessage: () => void;
  handleToggleCracker: () => void;
}

export function useAppShell({
  routeSettingsSection,
  onNavigateSettings,
  onCloseSettingsRoute,
}: UseAppShellOptions = {}): UseAppShellResult {
  const routeControlled = routeSettingsSection !== undefined;
  const [showNewMessage, setShowNewMessage] = useState(false);
  const [localShowSettings, setLocalShowSettings] = useState(false);
  const [localSettingsSection, setLocalSettingsSection] = useState<SettingsSection>('radio');
  const showSettings = routeControlled ? routeSettingsSection !== null : localShowSettings;
  const settingsSection = routeSettingsSection ?? localSettingsSection;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showCracker, setShowCracker] = useState(false);
  const [crackerRunning, setCrackerRunning] = useState(false);
  const [localLabel, setLocalLabel] = useState(getLocalLabel);
  const [distanceUnit, setDistanceUnit] = useState(getSavedDistanceUnit);
  const [renderRichPayloads, setRenderRichPayloads] = useState(getSavedRenderRichPayloads);
  const [showPathHopWidth, setShowPathHopWidth] = useState(getSavedShowPathHopWidth);
  useEffect(() => {
    if (routeSettingsSection) setLocalSettingsSection(routeSettingsSection);
  }, [routeSettingsSection]);

  const setSettingsSection = useCallback(
    (section: SettingsSection) => {
      setLocalSettingsSection(section);
      onNavigateSettings?.(section);
    },
    [onNavigateSettings]
  );

  const handleCloseSettingsView = useCallback(() => {
    if (onCloseSettingsRoute) {
      onCloseSettingsRoute();
    } else {
      setLocalShowSettings(false);
    }
    setSidebarOpen(false);
  }, [onCloseSettingsRoute]);

  const handleOpenSettingsSection = useCallback(
    (section: SettingsSection) => {
      setLocalSettingsSection(section);
      if (onNavigateSettings) {
        onNavigateSettings(section);
      } else {
        setLocalShowSettings(true);
      }
      setSidebarOpen(false);
    },
    [onNavigateSettings]
  );

  const handleToggleSettingsView = useCallback(() => {
    if (showSettings) {
      handleCloseSettingsView();
      return;
    }

    handleOpenSettingsSection(settingsSection);
  }, [handleCloseSettingsView, handleOpenSettingsSection, settingsSection, showSettings]);

  const handleOpenNewMessage = useCallback(() => {
    setShowNewMessage(true);
    setSidebarOpen(false);
  }, []);

  const handleCloseNewMessage = useCallback(() => {
    setShowNewMessage(false);
  }, []);

  const handleToggleCracker = useCallback(() => {
    setShowCracker((prev) => !prev);
  }, []);

  return {
    showNewMessage,
    showSettings,
    settingsSection,
    sidebarOpen,
    showCracker,
    crackerRunning,
    localLabel,
    distanceUnit,
    renderRichPayloads,
    showPathHopWidth,
    setSettingsSection,
    setSidebarOpen,
    setCrackerRunning,
    setLocalLabel,
    setDistanceUnit,
    setRenderRichPayloads,
    setShowPathHopWidth,
    handleCloseSettingsView,
    handleToggleSettingsView,
    handleOpenSettingsSection,
    handleOpenNewMessage,
    handleCloseNewMessage,
    handleToggleCracker,
  };
}
