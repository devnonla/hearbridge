import type { CSSProperties } from "react";

type Props = {
  value: number;
  min: number;
  max: number;
  step?: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
  "aria-label": string;
};

/** Native range input themed with NonlaUI tokens (the kit ships no slider). */
export function RangeField({ value, min, max, step = 1, format, onChange, ...rest }: Props) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className="flex w-full items-center gap-3">
      <input
        type="range"
        className="hb-range min-w-0 flex-1"
        style={{ "--hb-pct": `${pct}%` } as CSSProperties}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={rest["aria-label"]}
      />
      <span className="text-muted-foreground w-12 shrink-0 text-right text-sm tabular-nums">
        {format(value)}
      </span>
    </div>
  );
}
