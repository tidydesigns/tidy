import type { ReactNode } from "react";

export function FormMessage({
  children,
  role = "alert",
}: {
  children: ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <p role={role} className="border-l-2 border-primary-orange pl-3 text-sm">
      {children}
    </p>
  );
}
