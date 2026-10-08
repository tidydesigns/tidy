const sources = {
  github: "/icons/github.svg",
  back: "/icons/iconoir/arrow-left.svg",
  folder: "/icons/iconoir/folder.svg",
  navFolder: "/icons/iconoir/nav-folder.svg",
  archive: "/icons/iconoir/archive.svg",
  vault: "/icons/iconoir/safe.svg",
  plug: "/icons/iconoir/plug.svg",
  settings: "/icons/iconoir/settings.svg",
  upgrade: "/icons/iconoir/arrow-up.svg",
  frame: "/icons/iconoir/frame-tool.svg",
  rectangle: "/icons/iconoir/square.svg",
  hand: "/icons/iconoir/drag-hand-gesture.svg",
  select: "/icons/iconoir/cursor-pointer.svg",
  comment: "/icons/iconoir/comment.svg",
  feedback: "/icons/iconoir/megaphone.svg",
  more: "/icons/iconoir/more-horiz.svg",
  zoomIn: "/icons/iconoir/zoom-in.svg",
  zoomOut: "/icons/iconoir/zoom-out.svg",
  xmark: "/icons/xmark.svg",
  eye: "/icons/eye.svg",
  check: "/icons/check.svg",
  copy: "/icons/copy.svg",
  arrowRight: "/icons/arrow-right.svg",
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
        maskImage: `url(${sources[name]})`,
        WebkitMaskImage: `url(${sources[name]})`,
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
