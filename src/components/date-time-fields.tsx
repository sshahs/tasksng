import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A day and a time side by side. The native pickers need about 10rem and
 * 7rem; the columns may shrink below that but never overlap each other.
 */
export function DateTimeFields({
  date,
  time,
  onDate,
  onTime,
  min,
  step,
  className,
}: {
  date: string;
  time: string;
  onDate: (date: string) => void;
  onTime: (time: string) => void;
  /** Earliest day, as yyyy-MM-dd. */
  min?: string;
  /** Seconds between times offered by the picker. */
  step?: number;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)_minmax(0,7.5rem)] gap-2", className)}>
      <label className="grid min-w-0 gap-1 text-xs">
        <span className="text-muted-foreground">Day</span>
        <Input type="date" value={date} min={min} onChange={(e) => onDate(e.target.value)} className="h-9 px-2" />
      </label>
      <label className="grid min-w-0 gap-1 text-xs">
        <span className="text-muted-foreground">Time</span>
        <Input type="time" step={step} value={time} onChange={(e) => onTime(e.target.value)} className="h-9 px-2" />
      </label>
    </div>
  );
}
