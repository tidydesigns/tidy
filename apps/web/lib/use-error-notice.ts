"use client";
import { useCallback } from "react";
import { useErrorNotice as useNotice } from "@tidy/ui/use-error-notice";
import { appErrorReporter } from "./posthog-client";
import type { AppErrorOperation } from "./privacy/error-diagnostics";

export function useErrorNotice(
  initial = "",
  operation: AppErrorOperation = "user_action",
  presentation: "toast" | "inline" = "toast",
) {
  const reporter = useCallback(() => appErrorReporter(operation), [operation]);
  return useNotice({ initial, reporter, presentation });
}
