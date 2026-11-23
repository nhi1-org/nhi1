// Chain head (2_ §2.2 prev; 9_ §5): a writer whose use bounced with err 21 re-reads its own head here.
// Signed like an ask; answers only for the signing key.
import { handleHead } from "../_shared/aua/handlers.ts";
import { serve } from "../_shared/aua/serve.ts";

serve("head", handleHead, 1024);
