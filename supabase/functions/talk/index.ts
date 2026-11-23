// Talk (2_ §2.4): the only layer with free text. Same envelope and chain as a use; its own quota; refused
// at the door when it carries a personal-data shape (23) or the canary is certain it tells the reader to do something (22).
import { handleTalk } from "../_shared/aua/handlers.ts";
import { serve } from "../_shared/aua/serve.ts";

serve("talk", handleTalk, 4096);
