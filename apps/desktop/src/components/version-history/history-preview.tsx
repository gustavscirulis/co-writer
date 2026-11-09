import { closeVersionHistory, useVersionPreview } from "@/hooks/use-version-history";
import { EditorScrollContainer } from "@/components/editor-area/editor-scroll-container";
import { HISTORY_DOCK_CLEARANCE, useHistoryPreviewView } from "./use-history-preview-view";
import "./version-history.css";

// WebKit drops the dock's backdrop blur over the masked scroller, so text scrolling under it would read through.
const UNDER_DOCK_FADE = `linear-gradient(to bottom, transparent ${HISTORY_DOCK_CLEARANCE - 32}px, black ${HISTORY_DOCK_CLEARANCE}px)`;

export function HistoryPreview({ path }: { path: string }) {
  const preview = useVersionPreview();
  const mount = useHistoryPreviewView(path, preview);
  return (
    <div
      data-history-preview
      className="absolute inset-0 z-20"
      style={{ maskImage: UNDER_DOCK_FADE, WebkitMaskImage: UNDER_DOCK_FADE }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        closeVersionHistory();
      }}
    >
      <EditorScrollContainer>
        <div style={{ height: HISTORY_DOCK_CLEARANCE }} />
        <div ref={mount} className="min-h-full" />
        <div aria-hidden="true" className="h-28" />
      </EditorScrollContainer>
    </div>
  );
}
