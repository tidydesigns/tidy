import { TidyLogo } from "@tidy/ui/tidy-logo";
import { version } from "../../../../../package.json";
import { isDesktopBeta } from "../../../../shared/app-release";
import betaArtwork from "../../assets/brand/cloud-beta.webp";
import productionArtwork from "../../assets/brand/cloud-production.webp";
import atmosphereArtwork from "../../assets/brand/cloud-atmosphere.webp";

const beta = isDesktopBeta(version);
export const desktopReleaseLabel = beta ? "Beta" : "Production";

export function ThreadAtmosphere() {
  return (
    <div
      aria-hidden="true"
      data-thread-atmosphere
      className="pointer-events-none absolute inset-x-0 bottom-0 -z-1 h-[min(29%,260px)] opacity-26 [[data-theme=dark]_&]:opacity-11 [@media(prefers-color-scheme:dark)]:[:root:not([data-theme=light])_&]:opacity-11"
    >
      <img src={atmosphereArtwork} alt="" className="size-full object-cover" />
      <div className="absolute inset-0 bg-linear-to-b from-panel via-panel/70 via-40% to-transparent" />
    </div>
  );
}

export function ThreadBranding() {
  return (
    <div
      data-thread-branding
      className="pointer-events-none absolute bottom-[calc(100%+64px)] left-1/2 flex -translate-x-1/2 flex-col items-center gap-3 select-none [@media(max-height:600px)]:hidden"
      aria-hidden="true"
    >
      <img
        className="block h-[46px] w-[100px] object-cover opacity-92 [clip-path:polygon(16%_0,92%_0,92%_25%,100%_25%,100%_75%,84%_75%,84%_100%,8%_100%,8%_75%,0_75%,0_25%,16%_25%)]"
        src={beta ? betaArtwork : productionArtwork}
        alt=""
        width={100}
        height={46}
        decoding="async"
      />
      <TidyLogo className="text-[26px]! leading-[34px]! text-[light-dark(#57534f,#c2bfba)]!" />
    </div>
  );
}
