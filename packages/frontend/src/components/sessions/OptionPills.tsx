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
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-600">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const selected = opt.value === value;
          const disabled = opt.disabled;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              disabled={disabled}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                disabled
                  ? "cursor-not-allowed bg-neutral-950 text-neutral-700 ring-1 ring-neutral-900"
                  : selected
                    ? "bg-neutral-100 text-neutral-950"
                    : "bg-neutral-900 text-neutral-400 ring-1 ring-neutral-800 hover:bg-neutral-800 hover:text-neutral-200"
              }`}
            >
              {opt.label}
              {opt.hint && (
                <span
                  className={`ml-1 text-[10px] ${
                    disabled
                      ? "text-neutral-700"
                      : selected
                        ? "text-neutral-500"
                        : "text-neutral-600"
                  }`}
                >
                  {opt.hint}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
