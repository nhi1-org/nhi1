// Key acts 1–7 (AUA §2.6): pause / unpause / cut / fork / handover / wake / revoke.
// Signed by the active holder key (wake: every dormant key). Every act is a public mark.
import { handleKey } from "../_shared/aua/handlers.ts";
import { serve } from "../_shared/aua/serve.ts";

serve("key", handleKey, 4096);
