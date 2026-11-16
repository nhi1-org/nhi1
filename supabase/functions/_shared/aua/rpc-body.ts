// How a PostgREST RPC response body becomes a value. A function that `returns void` answers 204 with no
// body: that is null, not an error. (11/11 and 11/12: `aua_report_sent` → 204 → `r.json()` threw, the daily
// report answered 500 err 16 after its writes; `aua_cost_add` would have stopped a report before it was
// written or mailed.) Apache-2.0.
export function rpcBody(text: string): unknown {
  return text.trim() === "" ? null : JSON.parse(text);
}
