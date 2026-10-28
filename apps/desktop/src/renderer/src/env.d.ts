import type { DesktopAPI } from "../../shared/contracts/desktop";

declare global {
  interface Window {
    tidy?: DesktopAPI;
    tidyMachines?: import("../../shared/remote").MachineBridge;
    tidyRemote?: import("../../shared/remote").RemoteBridge;
  }
}
