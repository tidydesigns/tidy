"use client";
import { use, type ComponentProps } from "react";
import { ReviewControl } from "@/components/github/review-control";
type Props = ComponentProps<typeof ReviewControl>;
export function EditorReviewControl({
  initial,
  ...props
}: Omit<Props, "initial"> & { initial: Props["initial"] | Promise<Props["initial"]> }) {
  const value = "then" in initial ? use(initial) : initial;
  return <ReviewControl {...props} initial={value} />;
}
