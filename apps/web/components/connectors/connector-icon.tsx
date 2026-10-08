import Image from "next/image";

/** Decorative brand mark; the connector name is rendered alongside it. */
export function ConnectorIcon({ src }: { src: string }) {
  return (
    <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-white">
      <Image src={src} alt="" width={20} height={20} className="size-5 object-contain" />
    </span>
  );
}
