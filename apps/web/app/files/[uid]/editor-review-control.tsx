"use client";
import { use, type ComponentProps } from "react";
import { ReviewControl } from "@/components/github/review-control";
import { useFeatureFlag } from "@/lib/use-feature-flag";
type Props = ComponentProps<typeof ReviewControl>;
type EditorProps = Omit<Props, "initial"> & {
  initial: Props["initial"] | Promise<Props["initial"]>;
};
export function EditorReviewControl(props: EditorProps) {
  const showGitHub = useFeatureFlag("github-connector");
  return showGitHub ? <LoadedReviewControl {...props} /> : null;
}
function LoadedReviewControl({ initial, ...props }: EditorProps) {
  const value = "then" in initial ? use(initial) : initial;
  return <ReviewControl {...props} initial={value} />;
}
