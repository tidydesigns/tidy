import type { ButtonHTMLAttributes } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "text";
};

export function Button({ variant = "primary", ...props }: ButtonProps) {
  const className =
    variant === "primary"
      ? "flex h-12 w-full items-center justify-center rounded-lg bg-primary-orange px-4 text-sm font-semibold text-on-brand hover:bg-primary-orange/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-black disabled:cursor-wait disabled:opacity-60"
      : "text-sm font-medium text-primary-black underline decoration-primary-orange underline-offset-4 hover:text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-black";

  return <button className={className} {...props} />;
}
