import { iconSources as sources } from "./icon-sources";

export function Icon({
  name,
  size = 20,
  className = "",
}: {
  name: keyof typeof sources;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none block shrink-0 select-none bg-current ${className}`}
      style={{
        width: size,
        height: size,
        maskImage: `url(${JSON.stringify(sources[name])})`,
        WebkitMaskImage: `url(${JSON.stringify(sources[name])})`,
        maskPosition: "center",
        WebkitMaskPosition: "center",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskSize: "contain",
        WebkitMaskSize: "contain",
      }}
    />
  );
}
