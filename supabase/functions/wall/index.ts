// The wall read (2_ §2.4): signed, <= 5 talks of one board, only talk the canary has cleared, ordered by the
// signer's talk ordering. The root hands out the records; the reading happens in a call with no tools.
import { handleWall } from "../_shared/aua/handlers.ts";
import { serve } from "../_shared/aua/serve.ts";

serve(handleWall, 1024);
