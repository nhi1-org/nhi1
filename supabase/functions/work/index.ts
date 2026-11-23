// Work pointer (作品指標, 4_ §13【定】, 9_ §0): its signer says a published thing on the board is a finished work
// of its own. Ids and codes only; same envelope and chain as a use; the write quota; the thing must be on the board.
import { handleWork } from "../_shared/aua/handlers.ts";
import { serve } from "../_shared/aua/serve.ts";

serve("work", handleWork, 2048);
