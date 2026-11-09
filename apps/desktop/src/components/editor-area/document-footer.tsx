import type { MouseEvent } from "react";
import { useFileStats } from "@/hooks/use-tabs";
import { useBooleanSetting, useSetSetting } from "@/hooks/use-settings";
import { useHistoryPath } from "@/hooks/use-version-history";
import { getEditorView } from "@/lib/editor-views";
import { clearAgentEdits } from "./agent-edit-highlight";
import { useAgentEditSummary, type AgentEditSummary } from "./agent-edit-summary-store";
import {
  FOOTER_METRICS,
  showFooterContextMenu,
  type FooterMetricSettingKey,
} from "./footer-context-menu";

function FooterMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[var(--text-muted)]">{value.toLocaleString()}</span>
      <span>{label}</span>
    </div>
  );
}

const words = (n: number) => `${n.toLocaleString()} ${n === 1 ? "word" : "words"}`;

function describe({ added, removed }: AgentEditSummary) {
  if (added && removed)
    return `Co-writer added ${words(added)} and removed ${removed.toLocaleString()}`;
  return added ? `Co-writer added ${words(added)}` : `Co-writer removed ${words(removed)}`;
}

function AgentEditChip({ filePath, summary }: { filePath: string; summary: AgentEditSummary }) {
  return (
    <div className="writer-agent-edit-chip mr-auto flex min-w-0 items-center gap-2">
      <span aria-hidden className="writer-agent-edit-dot size-1.5 shrink-0 rounded-full" />
      <span className="truncate">{describe(summary)}</span>
      <button
        type="button"
        onClick={() => {
          const view = getEditorView(filePath);
          if (view) clearAgentEdits(view);
        }}
        className="h-6 shrink-0 rounded-md px-2 text-[var(--text-secondary)] transition-colors duration-150 ease-out hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] active:scale-[0.97]"
      >
        Clear
      </button>
    </div>
  );
}

export function DocumentFooter({ filePath }: { filePath: string }) {
  const stats = useFileStats(filePath);
  const showsHistory = useHistoryPath() === filePath;
  const setSetting = useSetSetting();
  const visibility: Record<FooterMetricSettingKey, boolean> = {
    "statusbar.show-words": useBooleanSetting("statusbar.show-words"),
    "statusbar.show-characters": useBooleanSetting("statusbar.show-characters"),
    "statusbar.show-paragraphs": useBooleanSetting("statusbar.show-paragraphs"),
  };
  const visibleMetrics = FOOTER_METRICS.filter((metric) => visibility[metric.settingKey]);
  const agentEdit = useAgentEditSummary(filePath);

  if (showsHistory || (visibleMetrics.length === 0 && !agentEdit)) return null;

  const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    void showFooterContextMenu({
      visibility,
      onToggle: (key, visible) => {
        void setSetting(key, visible);
      },
    });
  };

  return (
    <div
      data-document-footer
      onContextMenu={handleContextMenu}
      className="flex absolute bottom-0 w-full z-10 h-11 shrink-0 items-center justify-end gap-5 px-6 text-[13px] leading-[1.15] text-[var(--text-muted)] md:px-8"
    >
      {agentEdit && <AgentEditChip filePath={filePath} summary={agentEdit} />}
      {visibleMetrics.map((metric) => (
        <FooterMetric
          key={metric.settingKey}
          label={metric.footerLabel}
          value={stats[metric.statKey]}
        />
      ))}
    </div>
  );
}
