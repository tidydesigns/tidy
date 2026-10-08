import type { InputHTMLAttributes } from "react";

type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  id: string;
};

export function TextField({ label, id, ...props }: TextFieldProps) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        className="h-12 w-full rounded-lg border border-primary-grey bg-transparent px-4 text-sm outline-none placeholder:text-secondary-ink focus-visible:border-primary-black focus-visible:ring-2 focus-visible:ring-primary-orange"
        {...props}
      />
    </div>
  );
}
