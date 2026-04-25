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
}

export function OptionPills<T extends string>({
  label,
  value,
  options,
  onChange,
}: OptionPillsProps<T>) {
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>{label}</SectionLabel>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <Pill
            key={opt.value}
            selected={opt.value === value}
            disabled={opt.disabled}
            meta={opt.hint}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </Pill>
        ))}
      </div>
    </div>
  );
}
