"use client";
import { useEffect, type RefObject } from "react";
import posthog from "posthog-js";
import { FrameStats, nodeBucket } from "@/lib/performance/frame-stats";
import { useEditorEvent } from "./use-editor-event";

/** Sample bounded frame histograms during interaction; idle editors do no frame work. */
export function useEditorPerformance(
  viewport: RefObject<HTMLElement | null>,
  count: number,
  panels: boolean,
  selection: boolean,
) {
  const context = useEditorEvent(() => ({
    node_bucket: nodeBucket(count),
    panels_open: panels,
    has_selection: selection,
  }));
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || Math.random() >= 0.05) return;
    const canvas = viewport.current;
    if (!canvas) return;
    const groups = new Map<
      string,
      {
        context: ReturnType<typeof context>;
        kind: string;
        stats: FrameStats;
        interactions: number;
        tasks: number;
        taskMs: number;
      }
    >();
    let active: (typeof groups extends Map<string, infer Group> ? Group : never) | null = null;
    let frame: number | undefined, stopTimer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    const stop = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      active = null;
      clearTimeout(stopTimer);
    };
    const tick = (time: number) => {
      if (!active || document.hidden) {
        stop();
        return;
      }
      if (last) active.stats.add(time - last);
      last = time;
      frame = requestAnimationFrame(tick);
    };
    const start = (kind: string) => {
      if (document.hidden) return;
      if (active) return;
      const details = context(),
        key = JSON.stringify([details, kind]);
      let group = groups.get(key);
      if (!group) {
        group = {
          context: details,
          kind,
          stats: new FrameStats(),
          interactions: 0,
          tasks: 0,
          taskMs: 0,
        };
        groups.set(key, group);
      }
      group.interactions++;
      active = group;
      last = 0;
      frame = requestAnimationFrame(tick);
    };
    const pointer = () => {
      stop();
      start("pointer");
      stopTimer = setTimeout(stop, 60_000);
    };
    const wheel = () => {
      start("wheel");
      clearTimeout(stopTimer);
      stopTimer = setTimeout(stop, 160);
    };
    const flush = () => {
      for (const group of groups.values())
        if (group.stats.frames)
          posthog.capture("editor_interaction_performance", {
            ...group.context,
            interaction: group.kind,
            sample_rate: 0.05,
            interactions: group.interactions,
            frames: group.stats.frames,
            frame_ms_mean: Math.round((group.stats.total / group.stats.frames) * 10) / 10,
            frame_ms_p95: group.stats.percentile(0.95),
            frame_ms_max: Math.round(group.stats.maximum),
            frames_over_34_ms: group.stats.slow,
            long_tasks: group.tasks,
            long_task_ms: Math.round(group.taskMs),
            hardware_concurrency: navigator.hardwareConcurrency,
          });
      groups.clear();
    };
    let observer: PerformanceObserver | undefined;
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      observer = new PerformanceObserver((list) => {
        if (active)
          for (const entry of list.getEntries()) {
            active.tasks++;
            active.taskMs += entry.duration;
          }
      });
      observer.observe({ type: "longtask" });
    }
    const visibility = () => {
      if (document.hidden) {
        stop();
        flush();
      }
    };
    const timer = setInterval(() => {
      if (!active) flush();
    }, 60_000);
    canvas.addEventListener("pointerdown", pointer, { passive: true });
    canvas.addEventListener("wheel", wheel, { passive: true });
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stop();
      flush();
      observer?.disconnect();
      clearInterval(timer);
      canvas.removeEventListener("pointerdown", pointer);
      canvas.removeEventListener("wheel", wheel);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [viewport, context]);
}
