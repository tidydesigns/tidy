import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { mobilePairingSchema, type MobilePairing } from "@tidy/agent-protocol/mobile";

const key = "tidy.mobile.pairing.v1";
// Web previews never persist bearer credentials in browser storage.
let browserPairing: MobilePairing | null = null;
export async function readPairing(): Promise<MobilePairing | null> {
  if (Platform.OS === "web") return browserPairing;
  const value = await SecureStore.getItemAsync(key);
  return value ? mobilePairingSchema.parse(JSON.parse(value)) : null;
}
export async function writePairing(pairing: MobilePairing | null) {
  if (Platform.OS === "web") {
    browserPairing = pairing;
    return;
  }
  if (!pairing) await SecureStore.deleteItemAsync(key);
  else
    await SecureStore.setItemAsync(key, JSON.stringify(pairing), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
}
