// Key holder view (AUA §2.6, act = 0). Holder-signed; every look writes a key record first.
import { handleKeyView } from "../_shared/aua/handlers.ts";
import { serve } from "../_shared/aua/serve.ts";

serve("key-view", handleKeyView, 4096);
