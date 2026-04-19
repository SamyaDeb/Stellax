import clsx from "clsx";
import type { InputHTMLAttributes, SelectHTMLAttributes, ReactNode } from "react";

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label?: string; suffix?: ReactNode };

export function Input({ label, suffix, className, id, ...rest }: InputProps) {
  return (
    <div className="flex flex-col gap-1">
      {label !== undefined && (
        <label htmlFor={id} className="text-xs text-stella-muted">
          {label}
        </label>
      )}
      <div className="relative">
        <input {...rest} id={id} className={clsx("input w-full num", suffix !== undefined && "pr-12", className)} />
        {suffix !== undefined && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-stella-muted">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  options: readonly { value: string; label: string }[];
};

export function Select({ label, options, className, id, ...rest }: SelectProps) {
  return (
    <div className="flex flex-col gap-1">
      {label !== undefined && (
        <label htmlFor={id} className="text-xs text-stella-muted">
          {label}
        </label>
      )}
      <select {...rest} id={id} className={clsx("input w-full", className)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
