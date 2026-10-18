const icons = {
  codex: new URL("./harness-icons/codex.svg", import.meta.url).href,
  claude: new URL("./harness-icons/claude.svg", import.meta.url).href,
};
/** The same approved provider marks used by web onboarding, tinted with currentColor. */
export function HarnessIcon({
  harness,
  size = 16,
}: {
  harness: keyof typeof icons;
  size?: number;
}) {
  const mask = `url(${JSON.stringify(icons[harness])})`;
  return (
    <span
      aria-hidden="true"
      className="harness-icon"
      style={{
        display: "inline-block",
        flexShrink: 0,
        width: size,
        height: size,
        backgroundColor: "currentColor",
        maskImage: mask,
        WebkitMaskImage: mask,
        maskRepeat: "no-repeat",
        maskPosition: "center",
        maskSize: "contain",
      }}
    />
  );
}
