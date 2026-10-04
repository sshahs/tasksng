import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { parseDue } from "@/lib/dates";
import {
  buildRule,
  describeRule,
  MONTH_NAMES,
  newRule,
  ordinalDay,
  parseRule,
  weekdayOf,
  weekOfMonth,
  WEEKDAY_NAMES,
  WEEKDAYS,
  type Freq,
  type RepeatRule,
  type Weekday,
} from "@/lib/rrule";
import { cn } from "@/lib/utils";

const UNITS: { value: Freq; one: string; many: string }[] = [
  { value: "DAILY", one: "day", many: "days" },
  { value: "WEEKLY", one: "week", many: "weeks" },
  { value: "MONTHLY", one: "month", many: "months" },
  { value: "YEARLY", one: "year", many: "years" },
];
const ORDINAL_CHOICES = [
  { value: "1", label: "first" },
  { value: "2", label: "second" },
  { value: "3", label: "third" },
  { value: "4", label: "fourth" },
  { value: "-1", label: "last" },
];
/** "weekday" = any of Monday…Friday (BYSETPOS). */
type DayChoice = Weekday | "weekday";

interface MonthlyState {
  mode: "day" | "weekday";
  day: number;
  ord: number;
  weekday: DayChoice;
}

function initialRule(rrule: string | null, due: string | null): RepeatRule {
  const parsed = parseRule(rrule);
  if (parsed) return parsed;
  const d = parseDue(due)?.date ?? new Date();
  const r = newRule("WEEKLY");
  r.byday = [{ ord: 0, day: weekdayOf(d) }];
  return r;
}

function monthlyFrom(r: RepeatRule, due: string | null): MonthlyState {
  const d = parseDue(due)?.date ?? new Date();
  const wk = weekOfMonth(d);
  const fallback: MonthlyState = { mode: "day", day: d.getDate(), ord: wk.last ? -1 : wk.nth, weekday: weekdayOf(d) };
  if (r.bymonthday.length === 1) return { ...fallback, mode: "day", day: r.bymonthday[0] };
  if (r.byday.length === 1 && r.byday[0].ord !== 0) return { ...fallback, mode: "weekday", ord: r.byday[0].ord, weekday: r.byday[0].day };
  if (r.bysetpos.length === 1 && r.byday.length === 5) return { ...fallback, mode: "weekday", ord: r.bysetpos[0], weekday: "weekday" };
  return fallback;
}

/** Puts the monthly choice back into the rule. */
function applyMonthly(r: RepeatRule, m: MonthlyState): RepeatRule {
  const next = { ...r, bymonthday: [] as number[], byday: [] as RepeatRule["byday"], bysetpos: [] as number[] };
  if (m.mode === "day") next.bymonthday = [m.day];
  else if (m.weekday === "weekday") {
    next.byday = (["MO", "TU", "WE", "TH", "FR"] as Weekday[]).map((day) => ({ ord: 0, day }));
    next.bysetpos = [m.ord];
  } else next.byday = [{ ord: m.ord, day: m.weekday }];
  return next;
}

export function RepeatEditor({
  open,
  onOpenChange,
  rrule,
  due,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rrule: string | null;
  due: string | null;
  onSave: (rrule: string) => void;
}) {
  const [rule, setRule] = useState<RepeatRule>(() => initialRule(rrule, due));
  const [monthly, setMonthly] = useState<MonthlyState>(() => monthlyFrom(rule, due));
  const [month, setMonth] = useState(1);
  const [ends, setEnds] = useState<"never" | "until" | "count">("never");

  useEffect(() => {
    if (!open) return;
    const r = initialRule(rrule, due);
    setRule(r);
    setMonthly(monthlyFrom(r, due));
    setMonth(r.bymonth[0] ?? (parseDue(due)?.date ?? new Date()).getMonth() + 1);
    setEnds(r.count ? "count" : r.until ? "until" : "never");
  }, [open, rrule, due]);

  const result = (): string => {
    let r: RepeatRule = { ...rule, extra: rule.extra.filter((p) => /^WKST=/i.test(p)) };
    if (r.freq === "MONTHLY") r = applyMonthly({ ...r, bymonth: [] }, monthly);
    else if (r.freq === "YEARLY") r = applyMonthly({ ...r, bymonth: [month] }, monthly);
    else if (r.freq === "DAILY") r = { ...r, byday: [], bymonthday: [], bysetpos: [], bymonth: [] };
    else r = { ...r, bymonthday: [], bysetpos: [], bymonth: [], byday: r.byday.map((d) => ({ ord: 0, day: d.day })) };
    if (ends === "never") r = { ...r, count: null, until: null };
    if (ends === "count") r = { ...r, until: null, count: r.count ?? 5 };
    if (ends === "until") r = { ...r, count: null, until: r.until ?? new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10) };
    return buildRule(r);
  };

  const unit = UNITS.find((u) => u.value === rule.freq)!;
  const weekdays = new Set(rule.byday.map((d) => d.day));
  const toggleDay = (d: Weekday) => {
    const next = new Set(weekdays);
    if (next.has(d)) next.delete(d);
    else next.add(d);
    if (!next.size) return;
    setRule({ ...rule, byday: WEEKDAYS.filter((w) => next.has(w)).map((day) => ({ ord: 0, day })) });
  };

  const dayOptions = (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={monthly.mode} onValueChange={(v) => setMonthly({ ...monthly, mode: v as MonthlyState["mode"] })}>
        <SelectTrigger className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="day">On day</SelectItem>
          <SelectItem value="weekday">On the</SelectItem>
        </SelectContent>
      </Select>
      {monthly.mode === "day" ? (
        <Select value={String(monthly.day)} onValueChange={(v) => setMonthly({ ...monthly, day: Number(v) })}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {[...Array.from({ length: 31 }, (_, i) => i + 1), -1].map((d) => (
              <SelectItem key={d} value={String(d)}>
                {d === -1 ? "Last day" : ordinalDay(d)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <>
          <Select value={String(monthly.ord)} onValueChange={(v) => setMonthly({ ...monthly, ord: Number(v) })}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ORDINAL_CHOICES.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={monthly.weekday} onValueChange={(v) => setMonthly({ ...monthly, weekday: v as DayChoice })}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEEKDAYS.map((d) => (
                <SelectItem key={d} value={d}>
                  {WEEKDAY_NAMES[d]}
                </SelectItem>
              ))}
              <SelectItem value="weekday">weekday</SelectItem>
            </SelectContent>
          </Select>
        </>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Custom repeat</DialogTitle>
          <DialogDescription>{describeRule(result())}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          <div className="flex items-center gap-2">
            <Label className="w-14 shrink-0">Every</Label>
            <Input
              type="number"
              min={1}
              max={999}
              value={rule.interval}
              onChange={(e) => setRule({ ...rule, interval: Math.max(1, Math.min(999, Number(e.target.value) || 1)) })}
              className="w-20"
              aria-label="Interval"
            />
            <Select value={rule.freq} onValueChange={(v) => setRule({ ...rule, freq: v as Freq })}>
              <SelectTrigger className="w-32" aria-label="Unit">
                <SelectValue>{rule.interval === 1 ? unit.one : unit.many}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {UNITS.map((u) => (
                  <SelectItem key={u.value} value={u.value}>
                    {rule.interval === 1 ? u.one : u.many}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {rule.freq === "WEEKLY" && (
            <div className="flex items-center gap-2">
              <Label className="w-14 shrink-0">On</Label>
              <div className="flex gap-1">
                {WEEKDAYS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleDay(d)}
                    aria-pressed={weekdays.has(d)}
                    title={WEEKDAY_NAMES[d]}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-full border text-xs font-medium transition-colors",
                      weekdays.has(d) ? "bg-primary text-primary-foreground border-primary" : "hover:bg-accent",
                    )}
                  >
                    {WEEKDAY_NAMES[d].slice(0, 2)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {rule.freq === "MONTHLY" && (
            <div className="flex items-start gap-2">
              <Label className="mt-2 w-14 shrink-0">When</Label>
              {dayOptions}
            </div>
          )}

          {rule.freq === "YEARLY" && (
            <div className="flex items-start gap-2">
              <Label className="mt-2 w-14 shrink-0">When</Label>
              <div className="grid gap-2">
                <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
                  <SelectTrigger className="w-40" aria-label="Month">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTH_NAMES.map((m, i) => (
                      <SelectItem key={m} value={String(i + 1)}>
                        In {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {dayOptions}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Label className="w-14 shrink-0">Ends</Label>
            <Select value={ends} onValueChange={(v) => setEnds(v as typeof ends)}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="never">Never</SelectItem>
                <SelectItem value="until">On date</SelectItem>
                <SelectItem value="count">After</SelectItem>
              </SelectContent>
            </Select>
            {ends === "until" && (
              <Input
                type="date"
                className="w-40"
                value={rule.until ?? new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10)}
                onChange={(e) => setRule({ ...rule, until: e.target.value || null })}
                aria-label="Last date"
              />
            )}
            {ends === "count" && (
              <>
                <Input
                  type="number"
                  min={1}
                  max={999}
                  className="w-20"
                  value={rule.count ?? 5}
                  onChange={(e) => setRule({ ...rule, count: Math.max(1, Number(e.target.value) || 1) })}
                  aria-label="Number of times"
                />
                <span className="text-muted-foreground text-sm">more times</span>
              </>
            )}
          </div>

          <div className="flex items-start gap-3 rounded-md border p-3">
            <Switch
              id="from-completion"
              checked={rule.fromCompletion}
              onCheckedChange={(on) => setRule({ ...rule, fromCompletion: on })}
            />
            <div className="grid gap-1">
              <Label htmlFor="from-completion">Repeat after completion</Label>
              <p className="text-muted-foreground text-xs">
                The next due date counts from the day you complete the task, e.g. “water the plants 3 days after last time”.
              </p>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onSave(result());
              onOpenChange(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
