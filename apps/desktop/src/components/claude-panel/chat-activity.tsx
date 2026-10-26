import {
  useChatActivity,
  useChatStatus,
  useToolPermissions,
  useHasChatMessages,
} from "@/hooks/use-claude";
import { needsAnswer } from "@/lib/claude-stream";
import { AgentIndicator } from "@/components/agent-indicator";

export function ChatActivity({ path }: { path: string | null }) {
  const status = useChatStatus(path);
  const hasMessages = useHasChatMessages(path);
  const activity = useChatActivity(path);
  const permissions = useToolPermissions(path);
  const waiting = status === "running" && permissions.length === 0;
  const shown = status === "stopping" || (waiting && activity !== "working");
  const shimmer = waiting && (activity === "thinking" || activity === "compacting");
  const label =
    status === "running"
      ? permissions.length > 0
        ? needsAnswer(permissions[0].tool)
          ? "Waiting for your answer."
          : "Waiting for your approval."
        : activity === "compacting"
          ? "Compacting conversation…"
          : activity === "thinking"
            ? "Thinking…"
            : activity === "working"
              ? "Using tools…"
              : "Responding…"
      : status === "stopping"
        ? "Finishing…"
        : status === "idle" && hasMessages
          ? "Finished."
          : "";
  return (
    <div
      className={shown ? "mt-5 flex items-center gap-2 text-[12px]" : "sr-only"}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {shown && <AgentIndicator state="running" />}
      <span className={shimmer ? "chat-thinking-shimmer" : "text-[var(--text-muted)]"}>
        {label}
      </span>
    </div>
  );
}
