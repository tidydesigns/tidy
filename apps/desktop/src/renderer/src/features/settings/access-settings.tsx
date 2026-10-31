import { useId, useSyncExternalStore } from "react";
import { SelectMenu } from "@tidy/ui/select-menu";
import { showToast } from "@tidy/ui/toast";
import { permissionModes } from "../../../../shared/contracts/permissions";
import {
  currentDefaultAccess,
  defaultAccessSchema,
  selectDefaultAccess,
  subscribeDefaultAccess,
} from "./access-preferences";

export function AccessSettings() {
  const access = useSyncExternalStore(subscribeDefaultAccess, currentDefaultAccess);
  const id = useId();
  const options = permissionModes.codex
    .filter((option) => defaultAccessSchema.safeParse(option.value).success)
    .map((option) =>
      option.value === "default"
        ? { ...option, description: "Ask when an action needs approval." }
        : option,
    );
  return (
    <div>
      <div className="settings-appearance-row">
        <span id={id}>Default access</span>
        <SelectMenu
          value={access}
          label="Default access"
          labelledBy={id}
          size="sm"
          className="w-44 shrink-0"
          options={options}
          onChange={(value) => {
            if (!selectDefaultAccess(defaultAccessSchema.parse(value)))
              showToast("Access changed for this session, but could not be remembered.");
          }}
        />
      </div>
      <p className="thread-naming-note">
        {options.find((option) => option.value === access)?.description} Applies to new threads.
        Change access for an existing thread in its composer.
      </p>
    </div>
  );
}
