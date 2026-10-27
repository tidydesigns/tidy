"use client";

import { useEffect, useRef } from "react";
import { wordmark } from "./tidy-wordmark-paths";
import styles from "./cloud-footer.module.css";

export function AnimatedWordmark() {
  const letters = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = letters.current;
    if (!svg) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let animations: Animation[] = [];
    const settle = () => {
      for (const animation of animations) animation.cancel();
      animations = [];
    };
    // Content is visible without JS. Animate only when the wordmark first enters view.
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        if (reduced.matches) return;
        animations = [...svg.querySelectorAll("[data-letter]")].map((letter, index) =>
          letter.animate(
            [
              { transform: "translateY(100px)", opacity: 0 },
              { transform: "translateY(0)", opacity: 1 },
            ],
            {
              duration: 1250,
              delay: index * 85,
              easing: "cubic-bezier(.16,1,.3,1)",
              fill: "backwards",
            },
          ),
        );
      },
      { threshold: 0.12 },
    );
    const onVisibility = () => {
      for (const animation of animations) {
        if (animation.playState === "finished" || animation.playState === "idle") continue;
        if (document.hidden) animation.pause();
        else animation.play();
      }
    };
    const onPreference = () => {
      if (reduced.matches) settle();
    };
    observer.observe(svg);
    reduced.addEventListener("change", onPreference);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      observer.disconnect();
      settle();
      reduced.removeEventListener("change", onPreference);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return (
    <svg
      ref={letters}
      viewBox={`0 0 ${wordmark.width} ${wordmark.height}`}
      role="img"
      aria-label="Tidy"
      className={styles.wordmarkSvg}
    >
      <title>Tidy</title>
      {wordmark.letters.map((letter) => (
        <g key={letter.character} data-letter={letter.character}>
          <path d={letter.d} />
        </g>
      ))}
    </svg>
  );
}
