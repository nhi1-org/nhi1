// Minimal MCP Streamable-HTTP client for the wind tunnel: initialize → tools/list (interface re-runs), and
// tools/call for cross-family re-runs (rpf) of read-only tools only (effect 0; the caller checks). Runtime-
// agnostic (fetch is injected). Apache-2.0.

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

async function mcpSession(url: string, fetchFn: Fetch, timeoutMs: number) {
  let sid: string | null = null;
  let n = 0;
  const rpc = async (method: string, params: unknown, notify = false) => {
    const h: Record<string, string> = {
      "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18",
    };
    if (sid) h["mcp-session-id"] = sid;
    const id = ++n;
    const msg = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
    const r = await fetchFn(url, { method: "POST", headers: h, body: JSON.stringify(msg), signal: AbortSignal.timeout(timeoutMs) });
    const s = r.headers.get("mcp-session-id");
    if (s) sid = s;
    if (notify) return null;
    if (!r.ok) throw new Error("mcp http " + r.status);
    const text = await r.text();
    let reply: { id?: number; result?: unknown; error?: unknown } | undefined;
    if ((r.headers.get("content-type") || "").includes("text/event-stream")) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        try {
          const m = JSON.parse(line.slice(5));
          if (m.id === id) reply = m;
        } catch { /* skip */ }
      }
    } else reply = JSON.parse(text);
    if (!reply || reply.error) throw new Error("mcp " + method + " no result");
    return reply.result as Record<string, unknown>;
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nhi1-wind", version: "0.1" } });
  await rpc("notifications/initialized", {}, true);
  return rpc;
}

export async function mcpListTools(url: string, fetchFn: Fetch, timeoutMs = 15000): Promise<Record<string, unknown>[]> {
  const rpc = await mcpSession(url, fetchFn, timeoutMs);
  const tools: Record<string, unknown>[] = [];
  let cursor: unknown;
  do {
    const r = (await rpc("tools/list", cursor ? { cursor } : {})) as { tools?: Record<string, unknown>[]; nextCursor?: unknown };
    tools.push(...(r.tools || []));
    cursor = r.nextCursor;
  } while (cursor && tools.length < 1000);
  return tools;
}

/** one tools/call; returns the raw result ({content, structuredContent?, isError?}) or throws */
export async function mcpCallTool(url: string, fetchFn: Fetch, name: string, args: Record<string, unknown>, timeoutMs = 30000) {
  const rpc = await mcpSession(url, fetchFn, timeoutMs);
  return (await rpc("tools/call", { name, arguments: args })) as { content?: unknown[]; structuredContent?: unknown; isError?: boolean };
}
