import { Pill } from "@/components/ui/Pill";
import { SectionLabel } from "@/components/ui/SectionLabel";

interface Option<T extends string> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

interface OptionPillsProps<T extends string> {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  /** Short explanation under the pills, e.g. why they are disabled. */
  note?: string;
}

export function OptionPills<T extends string>({
  label,
  value,
  options,
  onChange,
  note,
}: OptionPillsProps<T>) {
  return (
    <div className="flex min-w-0 flex-col gap-2 [overflow-wrap:anywhere]">
      <SectionLabel>{label}</SectionLabel>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <Pill
            key={opt.value}
            selected={opt.value === value}
            disabled={opt.disabled}
            meta={opt.hint}
            className="min-w-0 max-w-full flex-wrap text-left pointer-coarse:min-h-10 [&>span]:min-w-0 [&>span]:max-w-full"
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </Pill>
        ))}
      </div>
      {note && <p className="text-muted-foreground text-xs">{note}</p>}
    </div>
  );
}
