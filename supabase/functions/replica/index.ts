// Replica pull (3_ §5, 4_ §13): any signed key gets the full record set; rate-limited, never refused
// for lack of seniority. Closed while knob replica_open = 0.
import { handleReplica } from "../_shared/aua/handlers.ts";
import { serve } from "../_shared/aua/serve.ts";

serve("replica", handleReplica, 1024);
