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
    return "border-emerald-400 bg-emerald-400/12 text-emerald-300";
  }

  if (["failed", "discarded", "cancelled", "expired"].includes(value)) {
    return "border-rose-500 bg-rose-500/12 text-rose-300";
  }

  if (
    ["queued", "planned", "reviewing", "created", "respawned", "waiting_steer", "stopped"].includes(
      value
    )
  ) {
    return "border-amber-400 bg-amber-400/12 text-amber-200";
  }

  return "border-cyan-400/60 bg-cyan-400/8 text-cyan-200";
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
      className="panel rounded-none border-2 border-[var(--line)] bg-[var(--paper)] py-0 shadow-[var(--shadow)]"
    >
      <CardHeader className="px-5 pt-5 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle className="font-heading text-[clamp(2rem,2.6vw,2.6rem)] tracking-[0.08em] text-[var(--emerald)]">
              {localizeUiText(title)}
            </CardTitle>
            {subtitle ? (
              <CardDescription className="mt-2 max-w-[720px] font-mono text-[var(--muted)]">
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
        "sub-panel rounded-none border-2 py-0 shadow-[var(--shadow)]",
        accent === "emerald"
          ? "border-emerald-400/70 bg-emerald-400/6"
          : "border-amber-400/70 bg-amber-400/6"
      )}
    >
      <CardHeader className="px-4 pt-4 pb-3">
        <CardTitle className="font-heading text-2xl tracking-[0.08em] text-[var(--ink)]">
          {localizeUiText(title)}
        </CardTitle>
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
        className="h-12 rounded-none border-2 border-emerald-400/60 bg-[rgba(7,14,27,0.94)] px-4 text-[var(--ink)] shadow-[4px_4px_0_0_rgba(74,222,128,0.28)]"
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
        className="min-h-[108px] rounded-none border-2 border-emerald-400/60 bg-[rgba(7,14,27,0.94)] px-4 py-3 font-mono leading-7 text-[var(--ink)] shadow-[4px_4px_0_0_rgba(74,222,128,0.28)]"
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
        <SelectTrigger className="h-12 w-full rounded-none border-2 border-emerald-400/60 bg-[rgba(7,14,27,0.94)] px-4 text-[var(--ink)] shadow-[4px_4px_0_0_rgba(74,222,128,0.28)]">
          <SelectValue placeholder={selectedOption ? localizeUiText(selectedOption.label) : "请选择"} />
        </SelectTrigger>
        <SelectContent className="rounded-none border-2 border-emerald-400/60 bg-[var(--popover)]">
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
    <Badge variant="outline" className={cn("rounded-none border-2 px-2.5 py-1 font-pixel text-[10px] uppercase tracking-[0.14em]", statusToneClass(value))}>
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
        "rounded-none border-2 border-cyan-400/60 bg-cyan-400/10 px-2.5 py-1 font-pixel text-[10px] uppercase tracking-[0.14em] text-cyan-200",
        tone === "amber" ? "border-amber-400 bg-amber-400/10 text-amber-200" : ""
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
      className="info-card rounded-none border-2 border-cyan-400/65 bg-[rgba(7,14,27,0.92)] py-0 shadow-[4px_4px_0_0_rgba(34,211,238,0.26)]"
    >
      <CardContent className="px-4 py-4">
        <span className="block font-pixel text-[10px] uppercase tracking-[0.14em] text-cyan-200">
          {localizeUiText(label)}
        </span>
        <strong className="mt-3 block break-words font-heading text-[1.7rem] leading-none tracking-[0.08em] text-[var(--ink)]">
          {value}
        </strong>
      </CardContent>
    </Card>
  );
}

export function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-2 border-cyan-400/60 bg-[rgba(7,14,27,0.9)] px-4 py-3 shadow-[4px_4px_0_0_rgba(34,211,238,0.24)]">
      <span className="block font-pixel text-[10px] uppercase tracking-[0.12em] text-cyan-200">
        {localizeUiText(label)}
      </span>
      <strong className="mt-3 block font-heading text-2xl leading-none tracking-[0.08em] text-[var(--ink)]">{value}</strong>
    </div>
  );
}

export function SectionList({ title, items }: { title: string; items: string[] }) {
  const displayItems = items.length > 0 ? items : ["暂无内容"];

  return (
    <section className="mt-4 min-w-0">
      <div className="mb-2 font-pixel text-[10px] uppercase tracking-[0.14em] text-cyan-200">
        {localizeUiText(title)}
      </div>
      <ul className="grid gap-2 pl-4 font-mono text-[14px] leading-7 text-[var(--ink)]">
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
      <div className="mb-2 font-pixel text-[10px] uppercase tracking-[0.14em] text-cyan-200">
        {localizeUiText(title)}
      </div>
      <ScrollArea className="max-h-72 border-2 border-emerald-400/60 bg-[rgba(2,10,16,0.96)]">
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
        "mt-4 rounded-none border-2 px-4 py-3 shadow-[4px_4px_0_0_rgba(0,0,0,0.35)]",
        tone === "rose"
          ? "border-rose-500 bg-[var(--rose-soft)] text-[var(--rose)]"
          : "border-amber-400 bg-[var(--amber-soft)] text-[var(--amber)]"
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
    <p className="border-2 border-dashed border-cyan-400/55 bg-cyan-400/6 px-4 py-5 font-mono text-sm leading-7 text-[var(--muted)]">
      {localizeUiText(text)}
    </p>
  );
}
