import { useState, type MouseEventHandler } from "react";
import { useRefreshDirectory } from "@/hooks/use-file-tree";
import { useBooleanSetting, useSetSetting, useSetting } from "@/hooks/use-settings";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { getWorkspaceIdentity, isCurrentWorkspaceIdentity } from "@/hooks/workspace-api";
import * as tauri from "@/lib/tauri";
import { createSidebarEntryAndRename } from "./create-sidebar-entry-and-rename";
import { showSidebarSurfaceContextMenu } from "./sidebar-surface-context-menu";
import { openSidebarDirectoryInTerminal } from "./sidebar-terminal-action";
import { DEFAULT_SIDEBAR_SORT_MODE, isSidebarSortMode } from "./sidebar-sort";
import type { RenameTarget } from "./file-tree";

export function useSidebarSurface() {
  const setSetting = useSetSetting();
  const showSearch = useBooleanSetting("appearance.sidebar-show-search");
  const showRecents = useBooleanSetting("appearance.sidebar-show-recents");
  const sortSetting = useSetting("appearance.sidebar-sort");
  const sortMode = isSidebarSortMode(sortSetting) ? sortSetting : DEFAULT_SIDEBAR_SORT_MODE;
  const foldersFirst = useBooleanSetting("appearance.sidebar-folders-first");
  const root = useWorkspaceRoot();
  const refreshDirectory = useRefreshDirectory();
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  const [everythingCollapsed, setEverythingCollapsed] = useState(false);

  const createRootEntry = (kind: tauri.SidebarEntryKind) => {
    if (!root) return;
    const identity = getWorkspaceIdentity();
    void createSidebarEntryAndRename(kind, {
      expandParent: () => setEverythingCollapsed(false),
      createEntry: (entryKind) => tauri.createSidebarEntry(root, entryKind),
      refreshRoot: () => refreshDirectory(root),
      startRenaming: (path) => setRenaming({ path, isNew: true }),
      isCurrentWorkspace: () => isCurrentWorkspaceIdentity(identity),
    }).catch((error: unknown) => {
      window.alert(
        `Failed to create ${kind}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  const runWorkspaceAction = (label: string, action: () => Promise<void>) => {
    void action().catch((error: unknown) => {
      window.alert(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const onContextMenu: MouseEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();
    void showSidebarSurfaceContextMenu({
      showSearch,
      showRecents,
      workspaceActions: root
        ? {
            sortMode,
            foldersFirst,
            onNewFile: () => createRootEntry("file"),
            onNewFolder: () => createRootEntry("folder"),
            onOpenInTerminal: () => {
              void openSidebarDirectoryInTerminal(null);
            },
            onOpenInFileManager: () =>
              runWorkspaceAction(
                "Failed to open workspace folder",
                tauri.openWorkspaceInFileManager,
              ),
            onSortModeChange: (mode) => {
              void setSetting("appearance.sidebar-sort", mode);
            },
            onFoldersFirstChange: (value) => {
              void setSetting("appearance.sidebar-folders-first", value);
            },
          }
        : null,
      onToggleSearch: (visible) => {
        void setSetting("appearance.sidebar-show-search", visible);
      },
      onToggleRecents: (visible) => {
        void setSetting("appearance.sidebar-show-recents", visible);
      },
    });
  };

  return {
    hasWorkspace: root !== null,
    onContextMenu,
    tree: {
      renaming,
      onRenamingChange: setRenaming,
      everythingCollapsed,
      onEverythingCollapsedChange: setEverythingCollapsed,
    },
  };
}
