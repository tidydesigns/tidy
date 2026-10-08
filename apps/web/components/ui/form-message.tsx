import type { ReactNode } from "react";

export function FormMessage({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="border-l-2 border-primary-orange pl-3 text-sm">
      {children}
    </p>
  );
}
