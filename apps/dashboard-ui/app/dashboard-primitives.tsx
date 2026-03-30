import type { ReactNode } from "react";
import { AlertCircle, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { localizeUiText, statusLabel } from "./copy";

function statusToneClass(value: string): string {
  if (["running", "kept", "completed", "applied"].includes(value)) {
    return "border-emerald-700/15 bg-emerald-700/10 text-emerald-800";
  }

  if (["failed", "discarded", "cancelled", "expired"].includes(value)) {
    return "border-rose-700/15 bg-rose-700/10 text-rose-800";
  }

  if (
    ["queued", "planned", "reviewing", "created", "respawned", "waiting_steer", "stopped"].includes(
      value
    )
  ) {
    return "border-amber-700/15 bg-amber-700/10 text-amber-800";
  }

  return "border-black/8 bg-black/6 text-[var(--muted)]";
}

export function Panel({
  title,
  subtitle,
  children,
  actions
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Card
      size="sm"
      className="panel rounded-[1.9rem] border border-[var(--line)] bg-[var(--paper)] py-0 shadow-[var(--shadow)] backdrop-blur-xl"
    >
      <CardHeader className="px-5 pt-5 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle className="text-[clamp(1.55rem,2vw,2rem)] tracking-[-0.03em] text-[var(--ink)]">
              {localizeUiText(title)}
            </CardTitle>
            {subtitle ? (
              <CardDescription className="mt-1.5 max-w-[720px] text-[var(--muted)]">
                {localizeUiText(subtitle)}
              </CardDescription>
            ) : null}
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5">{children}</CardContent>
    </Card>
  );
}

export function SubPanel({
  title,
  accent,
  children
}: {
  title: string;
  accent: "emerald" | "amber";
  children: ReactNode;
}) {
  return (
    <Card
      size="sm"
      className={cn(
        "sub-panel rounded-[1.6rem] border border-black/5 bg-white/55 py-0 shadow-none",
        accent === "emerald"
          ? "ring-1 ring-emerald-800/8"
          : "ring-1 ring-amber-700/10"
      )}
    >
      <CardHeader className="px-4 pt-4 pb-3">
        <CardTitle className="text-lg text-[var(--ink)]">{localizeUiText(title)}</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">{children}</CardContent>
    </Card>
  );
}

export function Field({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-2">
      <span className="text-[13px] text-[var(--muted)]">{localizeUiText(label)}</span>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-12 rounded-[1.15rem] border-black/10 bg-[rgba(255,252,247,0.92)] px-4 text-[var(--ink)] shadow-none"
      />
    </label>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="grid gap-2">
      <span className="text-[13px] text-[var(--muted)]">{localizeUiText(label)}</span>
      <Textarea
        value={value}
        placeholder={placeholder ? localizeUiText(placeholder) : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-[108px] rounded-[1.15rem] border-black/10 bg-[rgba(255,252,247,0.92)] px-4 py-3 leading-7 text-[var(--ink)] shadow-none"
        rows={4}
      />
    </label>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{
    value: string;
    label: string;
  }>;
}) {
  const selectedOption = options.find((option) => option.value === value);

  return (
    <label className="grid gap-2">
      <span className="text-[13px] text-[var(--muted)]">{localizeUiText(label)}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-12 w-full rounded-[1.15rem] border-black/10 bg-[rgba(255,252,247,0.92)] px-4 text-[var(--ink)] shadow-none">
          <SelectValue placeholder={selectedOption ? localizeUiText(selectedOption.label) : "请选择"} />
        </SelectTrigger>
        <SelectContent className="rounded-[1rem] border-black/10 bg-[var(--popover)]">
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {localizeUiText(option.label)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

export function StatusPill({ value }: { value: string }) {
  return (
    <Badge variant="outline" className={cn("rounded-full px-2.5 py-1 uppercase tracking-[0.08em]", statusToneClass(value))}>
      {statusLabel(value)}
    </Badge>
  );
}

export function InlineTag({
  label,
  tone = "neutral"
}: {
  label: string;
  tone?: "neutral" | "amber";
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full border-black/8 bg-white/70 px-2.5 py-1 uppercase tracking-[0.08em] text-[var(--muted)]",
        tone === "amber" ? "border-amber-700/15 bg-amber-700/10 text-amber-800" : ""
      )}
    >
      {localizeUiText(label)}
    </Badge>
  );
}

export function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <Card
      size="sm"
      className="info-card rounded-[1.35rem] border border-black/7 bg-[linear-gradient(180deg,rgba(255,252,247,0.96),rgba(247,240,231,0.82))] py-0 shadow-none"
    >
      <CardContent className="px-4 py-4">
        <span className="block text-[11px] uppercase tracking-[0.12em] text-[var(--muted)]">
          {localizeUiText(label)}
        </span>
        <strong className="mt-2.5 block break-words text-[15px] leading-7 text-[var(--ink)]">
          {value}
        </strong>
      </CardContent>
    </Card>
  );
}

export function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[1.1rem] border border-black/7 bg-[rgba(255,252,247,0.88)] px-4 py-3">
      <span className="block text-[11px] uppercase tracking-[0.08em] text-[var(--muted)]">
        {localizeUiText(label)}
      </span>
      <strong className="mt-2 block leading-6 text-[var(--ink)]">{value}</strong>
    </div>
  );
}

export function SectionList({ title, items }: { title: string; items: string[] }) {
  const displayItems = items.length > 0 ? items : ["暂无内容"];

  return (
    <section className="mt-4 min-w-0">
      <div className="mb-2 text-[11px] uppercase tracking-[0.12em] text-[var(--muted)]">
        {localizeUiText(title)}
      </div>
      <ul className="grid gap-2 pl-4 text-[14px] leading-7 text-[var(--ink)]">
        {displayItems.map((item, index) => (
          <li key={`${title}-${index}-${item}`} className="break-words">
            {localizeUiText(item)}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CodeBlock({
  title,
  value
}: {
  title: string;
  value: string;
}) {
  return (
    <section className="mt-4 min-w-0">
      <div className="mb-2 text-[11px] uppercase tracking-[0.12em] text-[var(--muted)]">
        {localizeUiText(title)}
      </div>
      <ScrollArea className="max-h-72 rounded-[1.15rem] border border-black/6 bg-[rgba(23,20,17,0.94)]">
        <pre className="monoBlock m-0 whitespace-pre-wrap break-words px-4 py-3 text-xs leading-7 text-[#f8f0e3]">
          {value}
        </pre>
      </ScrollArea>
    </section>
  );
}

export function Callout({
  title,
  tone,
  children
}: {
  title: string;
  tone: "rose" | "amber";
  children: ReactNode;
}) {
  const Icon = tone === "rose" ? AlertCircle : AlertTriangle;

  return (
    <Alert
      variant={tone === "rose" ? "destructive" : "default"}
      className={cn(
        "mt-4 rounded-[1.15rem] border px-4 py-3",
        tone === "rose"
          ? "border-rose-700/20 bg-[var(--rose-soft)] text-[var(--rose)]"
          : "border-amber-700/20 bg-[var(--amber-soft)] text-[var(--amber)]"
      )}
    >
      <Icon className="size-4" />
      <AlertTitle>{localizeUiText(title)}</AlertTitle>
      <AlertDescription className="text-current/90">{children}</AlertDescription>
    </Alert>
  );
}

export function EmptyState({ text }: { text: string }) {
  return (
    <p className="rounded-[1.15rem] border border-dashed border-black/10 bg-white/45 px-4 py-5 text-sm leading-7 text-[var(--muted)]">
      {localizeUiText(text)}
    </p>
  );
}
