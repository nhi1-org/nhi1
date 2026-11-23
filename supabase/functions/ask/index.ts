// AUA ask → view (≤ k views, each ≤ 1 KB) + lease, even for 0 views. Reading needs nothing.
import { handleAsk } from "../_shared/aua/handlers.ts";
import { serve } from "../_shared/aua/serve.ts";

serve("ask", handleAsk, 1024);
