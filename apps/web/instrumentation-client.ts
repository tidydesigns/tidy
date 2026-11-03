import "./lib/schema-client-config";
import { startPostHogConsent } from "./lib/posthog-client";
import { readWebsiteAttribution } from "@tidy/ui/website-attribution";

readWebsiteAttribution();
startPostHogConsent();
