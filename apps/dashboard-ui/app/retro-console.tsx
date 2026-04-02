"use client";

import { useEffect, useMemo, useState } from "react";
import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  Cpu,
  MoonStar,
  Radar,
  ShieldAlert,
  Siren,
  SquareTerminal
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { localizeUiText, nextActionLabel, statusLabel, workerLabel } from "./copy";
import {
  deriveRunOperatorState,
  formatDuration,
  formatRelativeTime,
  truncateText
} from "./dashboard-helpers";
import { MeasuredText } from "./measured-text";
import type { RunSummaryItem, ViewMode } from "./dashboard-types";

type ConsoleStat = {
  label: string;
  value: string;
};

type SnapshotStat = {
  label: string;
  value: string;
  hint: string;
  tone: "rose" | "amber" | "emerald";
};

type LaneId = "manual" | "running" | "standby";

const LANE_META: Record<
  LaneId,
  {
    title: string;
    subtitle: string;
    tone: "rose" | "amber" | "emerald";
  }
> = {
  manual: {
    title: "人工介入队列",
    subtitle: "人工优先位 / operator reclaim",
    tone: "rose"
  },
  running: {
    title: "运行池",
    subtitle: "active swarm / live agents",
    tone: "emerald"
  },
  standby: {
    title: "观测池",
    subtitle: "standby / watch mode",
    tone: "amber"
  }
};

function laneForRun(run: RunSummaryItem, nowTs: number): LaneId {
  const operatorState = deriveRunOperatorState(run, nowTs);

  if (operatorState.kind === "needs_action" || operatorState.kind === "at_risk") {
    return "manual";
  }

  if (
    run.current?.run_status === "running" ||
    run.latest_attempt?.status === "running" ||
    operatorState.kind === "active"
  ) {
    return "running";
  }

  return "standby";
}

function buildInitialLanes(runs: RunSummaryItem[], nowTs: number): Record<LaneId, string[]> {
  const lanes: Record<LaneId, string[]> = {
    manual: [],
    running: [],
    standby: []
  };

  for (const run of runs) {
    lanes[laneForRun(run, nowTs)].push(run.run.id);
  }

  return lanes;
}

function reconcileLanes(
  previous: Record<LaneId, string[]>,
  runs: RunSummaryItem[],
  nowTs: number
): Record<LaneId, string[]> {
  const next = buildInitialLanes(runs, nowTs);
  const presentIds = new Set(runs.map((run) => run.run.id));
  const assigned = new Set<string>();
  const merged: Record<LaneId, string[]> = {
    manual: [],
    running: [],
    standby: []
  };

  for (const lane of Object.keys(previous) as LaneId[]) {
    for (const runId of previous[lane]) {
      if (!presentIds.has(runId) || assigned.has(runId)) {
        continue;
      }

      merged[lane].push(runId);
      assigned.add(runId);
    }
  }

  for (const lane of Object.keys(next) as LaneId[]) {
    for (const runId of next[lane]) {
      if (assigned.has(runId)) {
        continue;
      }

      merged[lane].push(runId);
      assigned.add(runId);
    }
  }

  return merged;
}

function findLane(lanes: Record<LaneId, string[]>, id: string): LaneId | null {
  if (id in lanes) {
    return id as LaneId;
  }

  for (const lane of Object.keys(lanes) as LaneId[]) {
    if (lanes[lane].includes(id)) {
      return lane;
    }
  }

  return null;
}

function toneClasses(tone: "rose" | "amber" | "emerald") {
  if (tone === "rose") {
    return "border-rose-500/75 bg-rose-500/8 shadow-[4px_4px_0_0_rgba(239,68,68,0.28)]";
  }

  if (tone === "amber") {
    return "border-amber-400/75 bg-amber-400/8 shadow-[4px_4px_0_0_rgba(251,191,36,0.24)]";
  }

  return "border-emerald-400/75 bg-emerald-400/8 shadow-[4px_4px_0_0_rgba(74,222,128,0.24)]";
}

function hudTone(tone: "rose" | "amber" | "emerald") {
  if (tone === "rose") {
    return "border-rose-400/55 text-rose-200";
  }

  if (tone === "amber") {
    return "border-amber-300/55 text-amber-200";
  }

  return "border-emerald-300/55 text-emerald-200";
}

function chineseLabelClass(tone: "cyan" | "amber" | "rose" | "slate" = "cyan") {
  if (tone === "amber") {
    return "text-[11px] font-semibold tracking-[0.08em] text-amber-200";
  }

  if (tone === "rose") {
    return "text-[11px] font-semibold tracking-[0.08em] text-rose-200";
  }

  if (tone === "slate") {
    return "text-[11px] font-semibold tracking-[0.08em] text-slate-300";
  }

  return "text-[11px] font-semibold tracking-[0.08em] text-cyan-200";
}

function deriveAgentName(run: RunSummaryItem, index: number) {
  const rawWorker = run.latest_attempt?.worker ?? "codex";
  const normalized = rawWorker
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase();

  return `${normalized || "AGENT"}-${String(index + 1).padStart(2, "0")}`;
}

function runHealthLabel(status: string | null | undefined): string {
  return status ? statusLabel(status) : "未知";
}

function hudMetricLabel(label: string): string {
  switch (label) {
    case "运行任务数":
      return "RUNS";
    case "运行中任务":
      return "ACTIVE";
    case "尝试数":
      return "ATTEMPTS";
    case "等待人工":
      return "WAITING";
    case "目标数":
      return "GOALS";
    case "运行中目标":
      return "LIVE GOALS";
    case "人工接球":
      return "HANDOFFS";
    case "Runtime 风险":
      return "RUNTIME";
    case "回放债务":
      return "REPLAY";
    case "冷启动池":
      return "COLD START";
    default:
      return label.toUpperCase();
  }
}

function hudStatusValue(text: string): string {
  switch (text) {
    case "数据已失联":
      return "LINK LOST";
    case "正在自动刷新":
      return "REFRESHING";
    case "数据偏陈旧":
      return "STALE DATA";
    case "自动刷新正常":
      return "LINK STABLE";
    default:
      return text;
  }
}

function MiniCodeMonitor() {
  return (
    <div className="cockpit-grid-bg screen-noise relative h-full overflow-hidden border-2 border-cyan-400/45 bg-[rgba(5,16,31,0.96)] p-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-pixel text-[9px] tracking-[0.18em] text-cyan-300">SWARM SCRIPT</div>
        <div className="font-pixel text-[9px] text-emerald-300">LIVE</div>
      </div>
      <div className="space-y-2 font-mono text-[11px] leading-5 text-emerald-200/95">
        <div>
          <span className="text-cyan-300">planner.ts</span>
          <span className="text-slate-500"> // parallel split</span>
        </div>
        <div className="pl-2 text-amber-200">branch(alpha) =&gt; collect evidence</div>
        <div className="pl-2 text-emerald-200">branch(beta) =&gt; verify contract</div>
        <div className="pl-2 text-cyan-100">judge.score(mainline)</div>
        <div className="pl-2 text-fuchsia-200">ctx.writeback(shared_facts)</div>
        <div className="pl-2 text-emerald-100">operator.steer(waiting_queue)</div>
      </div>
    </div>
  );
}

function WorldMapMonitor() {
  return (
    <div className="cockpit-grid-bg relative h-full overflow-hidden border-2 border-cyan-400/45 bg-[linear-gradient(180deg,rgba(12,43,68,0.96),rgba(6,18,34,0.98))] p-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-pixel text-[9px] tracking-[0.18em] text-cyan-300">GLOBAL COVERAGE</div>
        <div className="font-pixel text-[9px] text-violet-200">MAP</div>
      </div>
      <svg viewBox="0 0 220 120" className="h-[112px] w-full">
        <rect x="0" y="0" width="220" height="120" fill="rgba(7,18,34,0.2)" />
        <path
          d="M18 34h40l8-12 18 4 8 15-9 12 6 10-18 8-17-6-13 8-22-2 4-16-9-7z"
          fill="rgba(34,211,238,0.62)"
        />
        <path
          d="M122 22h28l13 10 8 14-6 12 14 8-4 14-18 10-34-2-11-12-19 4-8-10 12-12 7-23 10-5z"
          fill="rgba(167,139,250,0.54)"
        />
        <path
          d="M88 82l12-4 17 5 6 10-8 8h-18l-12-8z"
          fill="rgba(74,222,128,0.56)"
        />
        <g stroke="rgba(125,211,252,0.25)" strokeWidth="1">
          <path d="M0 40h220" />
          <path d="M0 70h220" />
          <path d="M56 0v120" />
          <path d="M110 0v120" />
          <path d="M164 0v120" />
        </g>
      </svg>
    </div>
  );
}

function PixelRobot({
  className,
  sleepy = false
}: {
  className?: string;
  sleepy?: boolean;
}) {
  return (
    <svg viewBox="0 0 128 128" className={className} aria-hidden="true">
      <rect x="40" y="18" width="48" height="42" rx="4" fill="#84ccff" />
      <rect x="46" y="24" width="36" height="30" fill="#dbeafe" />
      <rect x="30" y="62" width="68" height="34" rx="4" fill="#a7f3d0" />
      <rect x="38" y="70" width="52" height="18" fill="#94a3b8" />
      <rect x="50" y="34" width="8" height="8" fill="#0f172a" />
      <rect x="70" y="34" width="8" height="8" fill="#0f172a" />
      <rect x="56" y="80" width="16" height="4" fill="#0f172a" />
      <rect x="54" y="8" width="4" height="10" fill="#67e8f9" />
      <rect x="70" y="8" width="4" height="10" fill="#67e8f9" />
      <rect x="56" y="4" width="16" height="6" fill="#38bdf8" />
      <rect x="22" y="72" width="12" height="8" fill="#93c5fd" />
      <rect x="94" y="72" width="12" height="8" fill="#93c5fd" />
      <rect x="44" y="96" width="10" height="20" fill="#93c5fd" />
      <rect x="74" y="96" width="10" height="20" fill="#93c5fd" />
      <rect x="38" y="114" width="18" height="6" fill="#67e8f9" />
      <rect x="72" y="114" width="18" height="6" fill="#67e8f9" />
      {sleepy ? (
        <>
          <text x="100" y="24" fill="#60a5fa" fontSize="20" fontFamily="monospace">
            Z
          </text>
          <text x="110" y="14" fill="#38bdf8" fontSize="14" fontFamily="monospace">
            z
          </text>
        </>
      ) : null}
    </svg>
  );
}

function InterferenceGraphic() {
  return (
    <svg viewBox="0 0 280 120" className="h-[110px] w-full">
      <rect x="0" y="0" width="280" height="120" fill="rgba(26,13,18,0.75)" />
      <path d="M0 88 C36 82, 58 24, 90 26 S154 100, 182 80 S246 14, 280 18" stroke="#38bdf8" strokeWidth="4" fill="none" />
      <path d="M0 60 C30 68, 54 96, 88 90 S150 18, 188 36 S236 96, 280 88" stroke="#f59e0b" strokeWidth="4" fill="none" />
      <path d="M0 34 C24 20, 46 24, 80 56 S150 110, 184 82 S238 28, 280 56" stroke="#22c55e" strokeWidth="4" fill="none" />
      <rect x="110" y="34" width="58" height="50" fill="rgba(2,6,23,0.82)" stroke="#fca5a5" strokeWidth="3" />
      <text x="118" y="58" fill="#fef08a" fontSize="10" fontFamily="monospace">
        ALERT
      </text>
      <text x="118" y="72" fill="#fca5a5" fontSize="10" fontFamily="monospace">
        FAILED TO
      </text>
      <text x="118" y="86" fill="#fca5a5" fontSize="10" fontFamily="monospace">
        FETCH
      </text>
    </svg>
  );
}

function GhostAgentCard({
  name,
  role
}: {
  name: string;
  role: string;
}) {
  return (
    <div className="micro-led relative overflow-hidden border-2 border-cyan-400/45 bg-[linear-gradient(180deg,rgba(17,35,63,0.96),rgba(7,16,31,0.98))] p-3">
      <div className="mb-3 flex items-start gap-3">
        <img
          src={`https://api.dicebear.com/7.x/pixel-art/svg?seed=${encodeURIComponent(name)}`}
          alt={`${name} avatar`}
          className="size-12 border-2 border-cyan-300/70 bg-black p-1"
        />
        <div className="min-w-0 flex-1">
          <div className="font-pixel text-[9px] tracking-[0.16em] text-cyan-300">{role}</div>
          <div className="font-hud text-2xl leading-none text-cyan-100">{name}</div>
          <p className="mt-2 text-xs leading-5 text-slate-300">
            典型运行卡位。等待后端实例接入后，这里会切换为真实 swarm agent。
          </p>
        </div>
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-3 text-xs text-cyan-100">
        <div className="h-2 self-center bg-cyan-400/20">
          <div className="h-full w-2/3 bg-gradient-to-r from-cyan-300 to-emerald-300" />
        </div>
        <div className="font-pixel text-[9px] text-amber-200">BOOT</div>
      </div>
    </div>
  );
}

function TelemetryStripItem({
  label,
  value,
  hint
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="micro-led border-2 border-cyan-400/45 bg-[rgba(10,25,44,0.96)] p-3">
      <div className="font-pixel text-[9px] tracking-[0.16em] text-cyan-300">{label}</div>
      <div className="mt-2 font-hud text-3xl leading-none text-cyan-50">{value}</div>
      <div className="mt-2 text-xs leading-5 text-slate-400">{hint}</div>
    </div>
  );
}

function AgentColumn({
  lane,
  items,
  runMap,
  selectedRunId,
  nowTs,
  onSelectRun
}: {
  lane: LaneId;
  items: string[];
  runMap: Map<string, RunSummaryItem>;
  selectedRunId: string | null;
  nowTs: number;
  onSelectRun: (runId: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: lane
  });
  const meta = LANE_META[lane];

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "cockpit-panel min-h-[440px] p-4",
        toneClasses(meta.tone),
        isOver ? "translate-x-[2px] translate-y-[2px]" : ""
      )}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="font-pixel text-[10px] tracking-[0.18em] text-cyan-300">{meta.subtitle}</div>
          <h3 className="mt-1 font-heading text-2xl font-black tracking-[0.06em] text-[var(--ink)]">
            {meta.title}
          </h3>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "rounded-none border-2 bg-black/30 px-2 py-1 font-hud text-2xl leading-none",
            hudTone(meta.tone)
          )}
        >
          {String(items.length).padStart(2, "0")}
        </Badge>
      </div>

      <SortableContext items={items} strategy={rectSortingStrategy}>
        <div className="grid gap-4">
          {items.map((runId, index) => {
            const run = runMap.get(runId);
            if (!run) {
              return null;
            }

            return (
              <AgentCard
                key={run.run.id}
                run={run}
                nowTs={nowTs}
                selected={run.run.id === selectedRunId}
                onSelect={() => onSelectRun(run.run.id)}
                agentName={deriveAgentName(run, index)}
              />
            );
          })}
        </div>
      </SortableContext>
    </section>
  );
}

function AgentCard({
  run,
  nowTs,
  selected,
  onSelect,
  agentName
}: {
  run: RunSummaryItem;
  nowTs: number;
  selected: boolean;
  onSelect: () => void;
  agentName: string;
}) {
  const operatorState = deriveRunOperatorState(run, nowTs);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: run.run.id
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };
  const isRunning =
    run.current?.run_status === "running" || run.latest_attempt_runtime_state?.running === true;
  const isErrored = operatorState.kind === "needs_action" || operatorState.kind === "at_risk";
  const tone = operatorState.tone;
  const governanceStatus = run.governance ? statusLabel(run.governance.status) : "未建";
  const healthStatus = runHealthLabel(run.run_health?.status);
  const logs =
    run.latest_attempt_runtime_state?.process_content.slice(-4) ??
    run.latest_attempt_runtime_state?.recent_activities.slice(-4) ??
    [];

  return (
    <button
      ref={setNodeRef}
      style={style}
      type="button"
      onClick={onSelect}
      className={cn(
        "micro-led relative w-full border-2 bg-[linear-gradient(180deg,rgba(17,35,63,0.96),rgba(7,16,31,0.98))] p-4 text-left transition-transform",
        toneClasses(tone),
        selected ? "outline-2 outline-offset-2 outline-cyan-300" : "",
        isDragging ? "opacity-70" : "hover:translate-x-[2px] hover:translate-y-[2px]"
      )}
      {...attributes}
      {...listeners}
    >
      <div className="mb-4 flex items-start gap-3">
        <img
          src={`https://api.dicebear.com/7.x/pixel-art/svg?seed=${encodeURIComponent(agentName)}`}
          alt={`${agentName} avatar`}
          className="size-16 border-2 border-cyan-300 bg-black p-1"
        />
        <div className="min-w-0 flex-1">
          <div className="font-pixel text-[10px] tracking-[0.18em] text-cyan-300">AGENT SLOT</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h4 className="font-hud text-[2rem] leading-none tracking-[0.06em] text-cyan-50">
              {agentName}
            </h4>
            <Badge
              variant="outline"
              className={cn("rounded-none border px-2 py-1 font-pixel text-[9px]", hudTone(tone))}
            >
              {operatorState.label}
            </Badge>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 font-mono text-[11px] text-slate-300">
            <span>{workerLabel(run.latest_attempt?.worker ?? "codex")}</span>
            <span>•</span>
            <span>{statusLabel(run.current?.run_status ?? "draft")}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 font-mono text-[11px]">
            <span className="border border-cyan-400/45 bg-black/40 px-2 py-1 text-cyan-100">
              治理 {governanceStatus}
            </span>
            <span className="border border-amber-400/45 bg-black/40 px-2 py-1 text-amber-100">
              健康 {healthStatus}
            </span>
          </div>
        </div>
      </div>

      <MeasuredText
        className="mb-4 text-sm leading-6 text-slate-100"
        lines={2}
        text={truncateText(
          localizeUiText(run.run_brief?.headline ?? run.task_focus ?? run.run.description),
          160
        )}
      />

      <div className="mb-4 grid grid-cols-2 gap-2 font-mono text-xs">
        <div className="border border-cyan-400/45 bg-black/40 px-2 py-2 text-cyan-100">
          <div className="font-pixel text-[9px] tracking-[0.14em] text-cyan-300">LAST PULSE</div>
          <div className="mt-2">{formatRelativeTime(run.current?.updated_at ?? run.run.created_at, nowTs)}</div>
        </div>
        <div className="border border-cyan-400/45 bg-black/40 px-2 py-2 text-cyan-100">
          <div className="font-pixel text-[9px] tracking-[0.14em] text-cyan-300">NEXT ACT</div>
          <div className="mt-2">{nextActionLabel(run.current?.recommended_next_action)}</div>
        </div>
      </div>

      <div className="border-2 border-cyan-400/50 bg-black/55">
        <div className="border-b-2 border-cyan-400/50 px-3 py-2 font-pixel text-[10px] tracking-[0.16em] text-cyan-200">
          {isErrored ? "ERROR STREAM" : isRunning ? "THOUGHT LOG" : "SLEEP MODE"}
        </div>
        <ScrollArea className="h-32 px-3 py-3">
          {isErrored ? (
            <div className="space-y-2 font-mono text-sm text-rose-300">
              <div className="flex items-center gap-2 font-pixel text-[10px] tracking-[0.16em] text-rose-300">
                <AlertTriangle className="size-4" />
                SIGNAL BREAK
              </div>
              <p>{localizeUiText(run.current?.blocking_reason ?? operatorState.reason)}</p>
            </div>
          ) : isRunning ? (
            <div className="space-y-2 font-mono text-sm text-emerald-200">
              {(logs.length > 0 ? logs : ["正在等待新的 thought log..."]).map((line, index) => (
                <p key={`${run.run.id}-log-${index}`} className="flex gap-2">
                  <span className="text-cyan-300">{">"}</span>
                  <span>{localizeUiText(line)}</span>
                </p>
              ))}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-amber-200">
              <MoonStar className="size-6" />
              <div className="font-pixel text-[10px] tracking-[0.16em]">Zzz / WATCH MODE</div>
              <p className="max-w-[22ch] font-mono text-sm text-[var(--muted)]">
                {localizeUiText(operatorState.recovery_hint)}
              </p>
            </div>
          )}
        </ScrollArea>
      </div>
    </button>
  );
}

export function MasterConsole({
  overviewStats,
  operatorSnapshot,
  viewMode,
  onViewModeChange,
  controlApiDisplay,
  defaultWorkspace,
  liveStatusText,
  liveStatusDetail
}: {
  overviewStats: ConsoleStat[];
  operatorSnapshot: SnapshotStat[];
  viewMode: ViewMode;
  onViewModeChange: (value: ViewMode) => void;
  controlApiDisplay: string;
  defaultWorkspace: string;
  liveStatusText: string;
  liveStatusDetail: string;
}) {
  return (
    <section className="cockpit-panel overflow-hidden p-4 md:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="font-pixel text-[10px] tracking-[0.18em] text-cyan-300">
          AISA / OPERATOR CONSOLE
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Tabs value={viewMode} onValueChange={(value) => onViewModeChange(value as ViewMode)}>
            <TabsList className="grid w-fit grid-cols-2 border-2 border-cyan-400/55 bg-[rgba(8,18,34,0.98)] p-1">
              <TabsTrigger value="runs" className="text-sm font-semibold tracking-[0.08em]">
                运行台
              </TabsTrigger>
              <TabsTrigger value="goals" className="text-sm font-semibold tracking-[0.08em]">
                目标池
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Badge
            variant="outline"
            className="rounded-none border border-emerald-300/55 bg-emerald-400/10 px-2 py-1 font-pixel text-[9px] text-emerald-200"
          >
            CONTROL PLANE
          </Badge>
          <Badge
            variant="outline"
            className="rounded-none border border-cyan-300/55 bg-cyan-400/10 px-2 py-1 font-pixel text-[9px] text-cyan-200"
          >
            MULTI-AGENT SWARM
          </Badge>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="grid gap-4">
          <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
            <div className="cockpit-grid-bg relative border-2 border-cyan-400/45 bg-[linear-gradient(180deg,rgba(15,38,67,0.94),rgba(8,19,36,0.98))] p-5">
              <div className="mb-3 w-fit border border-cyan-300/30 bg-cyan-400/10 px-3 py-1 font-pixel text-[9px] tracking-[0.18em] text-cyan-200">
                AISA
              </div>
              <h1 className="text-[clamp(2.75rem,5vw,4.5rem)] font-black leading-[0.96] tracking-[-0.04em] text-cyan-50">
                运行台优先
              </h1>
              <p className="mt-3 max-w-[40ch] text-sm leading-7 text-slate-200">
                先处理掉需要人工介入的蓝灯，再回头看未衰减的目标与分支看板。
              </p>
              <p className="mt-2 max-w-[44ch] text-sm leading-7 text-slate-400">
                这里展示的是作战态势、问题板、快照提示，而不是传统数据表格。目标是把多 agent
                调度、共享上下文、steer 和评估压到同一屏。
              </p>
            </div>

            <div className="grid gap-4">
              <MiniCodeMonitor />
              <WorldMapMonitor />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="micro-led border-2 border-cyan-400/45 bg-[rgba(10,29,50,0.95)] px-4 py-3">
              <div className="font-pixel text-[9px] tracking-[0.18em] text-cyan-300">API</div>
              <div className="mt-2 text-sm font-semibold text-cyan-50">{controlApiDisplay}</div>
            </div>
            <div className="micro-led border-2 border-cyan-400/45 bg-[rgba(10,29,50,0.95)] px-4 py-3">
              <div className="font-pixel text-[9px] tracking-[0.18em] text-cyan-300">WORKSPACE</div>
              <div className="mt-2 break-all text-sm text-slate-300">{defaultWorkspace}</div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            {overviewStats.map((stat, index) => {
              const accentClasses =
                index === 1
                  ? "border-amber-400/55 text-amber-200"
                  : index === 2
                    ? "border-fuchsia-400/55 text-fuchsia-200"
                    : index === 5
                      ? "border-rose-400/55 text-rose-200"
                      : "border-emerald-400/55 text-emerald-200";

              return (
                <div
                  key={stat.label}
                  className={cn(
                    "micro-led border-2 bg-[rgba(8,18,34,0.98)] px-4 py-3",
                    accentClasses
                  )}
                >
                  <div className="font-pixel text-[9px] tracking-[0.14em] text-slate-300">
                    {hudMetricLabel(stat.label)}
                  </div>
                  <div className="mt-3 font-hud text-5xl leading-none text-current pixel-glow-soft">
                    {stat.value}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid gap-4">
          <div className="grid gap-4 md:grid-cols-[0.9fr_1.1fr] xl:grid-cols-[0.9fr_1.1fr]">
            <div className="micro-led border-2 border-cyan-400/45 bg-[linear-gradient(180deg,rgba(13,30,54,0.96),rgba(7,16,31,0.98))] p-4">
              <div className="mb-3 font-pixel text-[9px] tracking-[0.18em] text-cyan-300">PRIMARY UNIT</div>
              <PixelRobot className="mx-auto h-28 w-28" />
              <div className="mt-3 text-center">
                <div className="font-hud text-3xl leading-none text-cyan-100">AISA-01</div>
                <div className="mt-1 font-pixel text-[9px] tracking-[0.16em] text-emerald-300">
                  ORCHESTRATOR HUB
                </div>
              </div>
            </div>

            <div className="grid gap-4">
              <div className="micro-led border-2 border-amber-400/55 bg-[linear-gradient(180deg,rgba(61,41,10,0.9),rgba(25,17,7,0.96))] p-4">
                <div className="mb-2 flex items-center gap-2">
                  <Radar className="size-4" />
                  <span className="font-pixel text-[10px] tracking-[0.18em] text-amber-200">
                    LIVE TELEMETRY
                  </span>
                </div>
                <div className="font-hud text-4xl leading-none text-amber-100">
                  {hudStatusValue(liveStatusText)}
                </div>
                <p className="mt-2 text-sm leading-6 text-amber-50/80">{liveStatusDetail}</p>
              </div>

              <div className="micro-led border-2 border-cyan-400/45 bg-[rgba(8,18,34,0.98)] p-3">
                <div className="mb-3 flex items-center gap-3">
                  <img
                    src="https://api.dicebear.com/7.x/pixel-art/svg?seed=aisa-operator"
                    alt="AISA operator avatar"
                    className="size-14 border-2 border-cyan-300 bg-black p-1"
                  />
                  <div className="min-w-0">
                    <div className="font-pixel text-[9px] tracking-[0.16em] text-cyan-300">OPERATOR LINK</div>
                    <div className="text-sm font-semibold text-cyan-50">手动接管 / 运行池 / 目标池</div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {operatorSnapshot.slice(0, 4).map((item) => (
                    <div
                      key={item.label}
                      className={cn("border px-2 py-2", hudTone(item.tone))}
                    >
                      <div className="font-pixel text-[8px] tracking-[0.14em] text-slate-300">
                        {hudMetricLabel(item.label)}
                      </div>
                      <div className="mt-2 font-hud text-3xl leading-none text-current">{item.value}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function InterferenceZone({
  dataState,
  error,
  liveAttemptText,
  latestSyncAgeMs,
  humanHandoffCount,
  runtimeRiskCount
}: {
  dataState: string;
  error: string | null;
  liveAttemptText: string;
  latestSyncAgeMs: number | null;
  humanHandoffCount: string;
  runtimeRiskCount: string;
}) {
  const stateLabel =
    dataState === "offline" ? "Failed to fetch" : dataState === "stale" ? "Signal degraded" : "Link stable";

  return (
    <section className="cockpit-panel overflow-hidden border-rose-400/50 bg-[linear-gradient(180deg,rgba(58,19,29,0.92),rgba(37,12,17,0.98))] p-4">
      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="grid gap-3 md:grid-cols-[0.95fr_1.05fr]">
          <div className="border-2 border-rose-300/45 bg-[rgba(42,13,21,0.9)] p-3">
            <div className="mb-3 flex items-center gap-2 font-pixel text-[10px] tracking-[0.18em] text-rose-200">
              <Siren className="size-4" />
              SYSTEM INTERFERENCE
            </div>
            <InterferenceGraphic />
          </div>

          <div className="border-2 border-rose-300/45 bg-[rgba(42,13,21,0.9)] p-4">
            <div className="font-pixel text-[10px] tracking-[0.18em] text-rose-200">ALERT TRACK</div>
            <div className="mt-2 text-4xl font-black leading-none text-rose-50">{stateLabel}</div>
            <p className="mt-3 text-sm leading-6 text-rose-50/85">
              {error ?? `${liveAttemptText}。当前人工接球 ${humanHandoffCount} 条，Runtime 风险 ${runtimeRiskCount} 条。`}
            </p>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="micro-led border-2 border-cyan-300/40 bg-black/25 px-4 py-3">
            <div className="font-pixel text-[9px] tracking-[0.14em] text-cyan-200">SYNC AGE</div>
            <div className="mt-2 font-hud text-3xl leading-none text-cyan-50">
              {latestSyncAgeMs !== null ? formatDuration(latestSyncAgeMs) : "N/A"}
            </div>
          </div>
          <div className="micro-led border-2 border-amber-300/40 bg-black/25 px-4 py-3">
            <div className="font-pixel text-[9px] tracking-[0.14em] text-amber-200">WAITING</div>
            <div className="mt-2 font-hud text-3xl leading-none text-amber-50">{humanHandoffCount}</div>
          </div>
          <div className="micro-led border-2 border-rose-300/40 bg-black/25 px-4 py-3">
            <div className="font-pixel text-[9px] tracking-[0.14em] text-rose-200">RUNTIME</div>
            <div className="mt-2 font-hud text-3xl leading-none text-rose-50">{runtimeRiskCount}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function AgentGridBoard({
  runs,
  nowTs,
  selectedRunId,
  onSelectRun
}: {
  runs: RunSummaryItem[];
  nowTs: number;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}) {
  const [lanes, setLanes] = useState<Record<LaneId, string[]>>(() => buildInitialLanes(runs, nowTs));
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  );

  useEffect(() => {
    setLanes((current) => reconcileLanes(current, runs, nowTs));
  }, [runs, nowTs]);

  const runMap = useMemo(() => new Map(runs.map((run) => [run.run.id, run])), [runs]);

  function moveItem(activeId: string, overId: string | null) {
    if (!overId) {
      return;
    }

    const fromLane = findLane(lanes, activeId);
    const toLane = findLane(lanes, overId);

    if (!fromLane || !toLane) {
      return;
    }

    if (fromLane === toLane) {
      const oldIndex = lanes[fromLane].indexOf(activeId);
      const newIndex =
        overId === toLane ? lanes[toLane].length - 1 : lanes[toLane].indexOf(overId);

      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        setLanes((current) => ({
          ...current,
          [fromLane]: arrayMove(current[fromLane], oldIndex, newIndex)
        }));
      }

      return;
    }

    setLanes((current) => {
      const nextFrom = current[fromLane].filter((id) => id !== activeId);
      const overIndex =
        overId === toLane ? current[toLane].length : current[toLane].indexOf(overId);
      const nextTo = [...current[toLane]];

      if (overIndex < 0) {
        nextTo.push(activeId);
      } else {
        nextTo.splice(overIndex, 0, activeId);
      }

      return {
        ...current,
        [fromLane]: nextFrom,
        [toLane]: nextTo
      };
    });
  }

  function handleDragOver(event: DragOverEvent) {
    if (!event.over) {
      return;
    }

    moveItem(String(event.active.id), String(event.over.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    if (!event.over) {
      return;
    }

    moveItem(String(event.active.id), String(event.over.id));
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-pixel text-[10px] tracking-[0.18em] text-cyan-300">
            ALL RUNS / KANBAN / DRAG ENABLED
          </div>
          <h2 className="mt-1 text-3xl font-black tracking-[-0.03em] text-cyan-50">运行池总览</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge
            variant="outline"
            className="rounded-none border-2 border-emerald-400/70 bg-emerald-400/10 px-2 py-1 font-pixel text-[10px] text-emerald-300"
          >
            <Cpu className="mr-1 size-3" />
            Drag to reassign
          </Badge>
          <Badge
            variant="outline"
            className="rounded-none border-2 border-cyan-400/70 bg-cyan-400/10 px-2 py-1 font-pixel text-[10px] text-cyan-200"
          >
            <SquareTerminal className="mr-1 size-3" />
            pixel avatar + live logs
          </Badge>
        </div>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="grid gap-4 xl:grid-cols-3">
          {(Object.keys(lanes) as LaneId[]).map((lane) => (
            <AgentColumn
              key={lane}
              lane={lane}
              items={lanes[lane]}
              runMap={runMap}
              selectedRunId={selectedRunId}
              nowTs={nowTs}
              onSelectRun={onSelectRun}
            />
          ))}
        </div>
      </DndContext>
    </section>
  );
}

export function CommandEmptyState({
  onSwitchGoals,
  operatorSnapshot
}: {
  onSwitchGoals: () => void;
  operatorSnapshot: SnapshotStat[];
}) {
  return (
    <section className="grid gap-4 xl:grid-cols-[260px_minmax(0,1.2fr)_520px]">
      <aside className="grid gap-4">
        <div className="cockpit-panel p-4">
          <div className="font-pixel text-[10px] tracking-[0.18em] text-cyan-300">Operator Snapshot</div>
          <div className="grid grid-cols-2 gap-3">
            {operatorSnapshot.slice(0, 4).map((item) => (
              <div key={item.label} className={cn("micro-led border-2 bg-[rgba(10,25,44,0.96)] p-3", hudTone(item.tone))}>
                <div className="font-pixel text-[8px] tracking-[0.14em] text-slate-300">
                  {hudMetricLabel(item.label)}
                </div>
                <div className="mt-2 font-hud text-4xl leading-none text-current">{item.value}</div>
                <div className="mt-2 text-xs leading-5 text-slate-400">{item.hint}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="cockpit-panel p-4">
          <div className="mb-3 flex items-center gap-2 font-pixel text-[10px] tracking-[0.18em] text-rose-200">
            <ShieldAlert className="size-4" />
            Runtime 风险
          </div>
          <div className="micro-led border-2 border-rose-300/40 bg-[rgba(37,14,22,0.95)] p-3">
            <MiniCodeMonitor />
          </div>
        </div>

        <div className="cockpit-panel overflow-hidden p-4">
          <div className="font-pixel text-[10px] tracking-[0.18em] text-cyan-300">Cold Start Bay</div>
          <div className="relative border-2 border-cyan-400/45 bg-[linear-gradient(180deg,rgba(19,39,69,0.96),rgba(8,16,31,0.98))] p-4">
            <PixelRobot className="mx-auto h-44 w-44" />
            <div className="mt-3 border-t border-cyan-400/35 pt-3">
              <div className="font-pixel text-[9px] tracking-[0.16em] text-cyan-200">CURRENT SLICE</div>
              <div className="mt-2 text-sm leading-6 text-slate-300">
                这里预留给未来的 idle agent staging 区和待唤醒 worker 说明。
              </div>
            </div>
          </div>
        </div>
      </aside>

      <div className="grid gap-4">
        <div className="cockpit-panel p-4 md:p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-pixel text-[10px] tracking-[0.18em] text-cyan-300">Current Task</div>
              <h2 className="mt-1 text-3xl font-black tracking-[-0.03em] text-cyan-50">等待新的任务分派</h2>
              <p className="mt-2 max-w-[46ch] text-sm leading-7 text-slate-300">
                入口还没有被后端实例填满，但运行台骨架已经准备好了。目标创建后，这块区域会展示主执行 Agent 的实时状态。
              </p>
            </div>
            <Button type="button" onClick={onSwitchGoals} className="self-start">
              打开目标池
            </Button>
          </div>

          <div className="cockpit-grid-bg flex min-h-[260px] items-center justify-center border-2 border-cyan-400/45 bg-[linear-gradient(180deg,rgba(11,31,56,0.96),rgba(6,15,29,0.98))] p-6">
            <div className="text-center">
              <PixelRobot className="mx-auto h-40 w-40" sleepy />
              <div className="mt-3 font-pixel text-[10px] tracking-[0.18em] text-cyan-300">NO ACTIVE AGENTS</div>
              <div className="mt-2 font-hud text-5xl leading-none text-cyan-50">WAITING FOR ASSIGNMENT</div>
            </div>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <TelemetryStripItem label="QUEUE" value="00" hint="人工介入队列当前为空。" />
          <TelemetryStripItem label="UPLINK" value="OK" hint="运行台骨架已准备，等待控制 API 回填。" />
          <TelemetryStripItem label="STAGE" value="IDLE" hint="当前主屏处于无任务待命状态。" />
        </div>
      </div>

      <aside className="cockpit-panel p-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="font-pixel text-[10px] tracking-[0.18em] text-cyan-300">All Runs</div>
            <h3 className="mt-1 text-2xl font-black tracking-[-0.03em] text-cyan-50">示意运行卡位</h3>
          </div>
          <div className="font-pixel text-[9px] tracking-[0.16em] text-slate-300">
            后端回填后自动切换为真实数据
          </div>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <GhostAgentCard name="Codex-1" role="Builder" />
          <GhostAgentCard name="Analyst" role="Research" />
          <GhostAgentCard name="Mediator-Alpha" role="Judge" />
          <GhostAgentCard name="Codex-2" role="Verifier" />
          <GhostAgentCard name="Signal-Node" role="Runtime" />
          <GhostAgentCard name="Planner-3" role="Planner" />
        </div>
      </aside>
    </section>
  );
}
