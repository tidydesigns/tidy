"use client";

import { navigateWithFreshSession } from "@/lib/navigation/actions";
import { authClient, resetPostHogUser } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  async function signOut() {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: async () => {
          resetPostHogUser();
          await navigateWithFreshSession("/login");
        },
      },
    });
  }

  return (
    <Button type="button" variant="text" onClick={signOut}>
      Sign out
    </Button>
  );
}
