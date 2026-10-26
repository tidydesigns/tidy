export const codeFontClassName = "[font-family:system-ui,sans-serif]";

export const codeStatusClassName =
  "[--desktop-status-active:light-dark(#2c5b96,#7cacdf)] [--desktop-status-warning:light-dark(#805f26,#dbb979)] [--desktop-status-danger:light-dark(#a63747,#e89098)]";

export const desktopNavigationClassName = `${codeFontClassName} ${codeStatusClassName} [--desktop-navigation-surface:light-dark(#f7f7f7,#121212)] [--color-subtle-fill:light-dark(#e9e9e9,#2b2b2b)] [--color-hover-surface:light-dark(#f0f0f0,#222222)] [--color-muted-ink:light-dark(#656565,#9f9f9f)]`;

export const codeMenuClassName = [
  codeFontClassName,
  "[&]:rounded-lg [&]:border-border [&]:bg-(--desktop-surface) [&]:p-1 [&]:text-ink [&]:shadow-[0_10px_30px_#0003]",
  "[&_[role^=menuitem]]:min-h-[31px] [&_[role^=menuitem]]:rounded-md [&_[role^=menuitem]]:px-2 [&_[role^=menuitem]]:py-1.5 [&_[role^=menuitem]]:text-xs [&_[role^=menuitem]]:leading-[18px]",
  "[&_[role^=menuitem]:hover]:bg-hover-surface [&_[role^=menuitem]:focus-visible]:bg-hover-surface",
  "[&_[data-slot=select-menu-label]]:font-normal [&_[data-slot=select-menu-label]]:leading-[18px]",
  "[&_[data-slot=select-menu-content]]:flex [&_[data-slot=select-menu-content]]:items-center [&_[data-slot=select-menu-content]]:gap-[7px] [&_[data-slot=select-menu-content]>svg]:size-3.5",
].join(" ");

export const codeControlClassName =
  "harness-setting-trigger flex min-h-[30px] max-w-[185px] cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-[5px] text-xs leading-5 text-muted-ink hover:bg-hover-surface [&>svg]:size-[15px] [&>svg]:shrink-0 max-[700px]:px-1 max-[700px]:text-[11px]";

export const codeContextClassName =
  "flex min-w-0 items-center gap-[7px] text-xs leading-[18px] text-muted-ink [&_svg]:size-[15px] [&_svg]:shrink-0 max-[700px]:gap-[5px] max-[700px]:text-[11px]";

export const codeContextTriggerClassName = `${codeContextClassName} context-trigger cursor-pointer rounded-md border-0 bg-transparent p-1.5 hover:enabled:bg-hover-surface hover:enabled:text-ink disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-control-border [&>span:first-of-type]:truncate`;

export const codeFavoriteClassName =
  "model-star mr-0.5 grid size-[25px] shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 leading-none text-muted-ink hover:bg-pressed-surface hover:text-ink active:transform-none [&_svg]:block [&_svg]:size-[15px] [&[aria-pressed=true]_svg]:fill-current";

export const codeSubmitClassName =
  "composer-submit inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 p-0 disabled:cursor-default disabled:opacity-40";
