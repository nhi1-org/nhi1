// AUA replay (S1): register a signed replay request for a use; answers the current rp. Engine is S2.
import { handleReplay } from "../_shared/aua/handlers.ts";
import { serve } from "../_shared/aua/serve.ts";

serve(handleReplay, 2048);
