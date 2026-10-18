const sources = {
  github: new URL("../../assets/icons/github.svg", import.meta.url).href,
  back: new URL("../../assets/icons/iconoir/arrow-left.svg", import.meta.url).href,
  folder: new URL("../../assets/icons/iconoir/folder.svg", import.meta.url).href,
  navFolder: new URL("../../assets/icons/iconoir/nav-folder.svg", import.meta.url).href,
  archive: new URL("../../assets/icons/iconoir/archive.svg", import.meta.url).href,
  vault: new URL("../../assets/icons/iconoir/safe.svg", import.meta.url).href,
  plug: new URL("../../assets/icons/iconoir/plug.svg", import.meta.url).href,
  settings: new URL("../../assets/icons/iconoir/settings.svg", import.meta.url).href,
  upgrade: new URL("../../assets/icons/iconoir/arrow-up.svg", import.meta.url).href,
  frame: new URL("../../assets/icons/iconoir/frame-tool.svg", import.meta.url).href,
  rectangle: new URL("../../assets/icons/iconoir/square.svg", import.meta.url).href,
  hand: new URL("../../assets/icons/iconoir/drag-hand-gesture.svg", import.meta.url).href,
  select: new URL("../../assets/icons/iconoir/cursor-pointer.svg", import.meta.url).href,
  comment: new URL("../../assets/icons/iconoir/comment.svg", import.meta.url).href,
  feedback: new URL("../../assets/icons/iconoir/megaphone.svg", import.meta.url).href,
  history: new URL("../../assets/icons/iconoir/clock-rotate-right.svg", import.meta.url).href,
  more: new URL("../../assets/icons/iconoir/more-horiz.svg", import.meta.url).href,
  menu: new URL("../../assets/icons/iconoir/menu.svg", import.meta.url).href,
  zoomIn: new URL("../../assets/icons/iconoir/zoom-in.svg", import.meta.url).href,
  zoomOut: new URL("../../assets/icons/iconoir/zoom-out.svg", import.meta.url).href,
  xmark: new URL("../../assets/icons/xmark.svg", import.meta.url).href,
  eye: new URL("../../assets/icons/eye.svg", import.meta.url).href,
  check: new URL("../../assets/icons/check.svg", import.meta.url).href,
  copy: new URL("../../assets/icons/copy.svg", import.meta.url).href,
  arrowRight: new URL("../../assets/icons/arrow-right.svg", import.meta.url).href,
} as const;

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
