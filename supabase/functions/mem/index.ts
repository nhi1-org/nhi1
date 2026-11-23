// NHI-2 private cabin (9_): one signed endpoint, ops put / head / boot / all / del. The root keeps shells and
// ciphertext only; every answer is for the signing key alone. A mem's ciphertext is <= 64 KB (base64url ~ 88 KB).
import { handleMem } from "../_shared/aua/mem.ts";
import { serve } from "../_shared/aua/serve.ts";

serve("mem", handleMem, 96 * 1024);
