// AUA use: verify Ed25519 → hard rules → rate gate → append. Lease redeemed if present; accepted without.
import { handleUse } from "../_shared/aua/handlers.ts";
import { serve } from "../_shared/aua/serve.ts";

serve(handleUse, 4096);
