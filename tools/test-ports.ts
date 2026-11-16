// Ports for the tests and the smoke run: one block of 20 per checkout, picked from the checkout's path, so two
// worktrees (or a worktree and main) running tests at the same time never take each other's ports, and no two
// tests in one checkout share one either. NHI1_TEST_PORT_BASE overrides the block. 20000–39999 stays clear of
// Windows' excluded ranges and of the ephemeral range (49152+). Apache-2.0.
import { createHash } from "node:crypto";
import { ROOT } from "./aua-json.ts";

const SPAN = 20;
const slot = parseInt(createHash("sha256").update(ROOT.toLowerCase()).digest("hex").slice(0, 8), 16) % 1000;
export const PORT_BASE = Number(process.env.NHI1_TEST_PORT_BASE) || 20000 + slot * SPAN;

/** the i-th port of this checkout's block (each test file takes its own fixed i) */
export function testPort(i: number): number {
  if (!Number.isInteger(i) || i < 0 || i >= SPAN) throw new Error(`test port index ${i} out of 0..${SPAN - 1}`);
  return PORT_BASE + i;
}

if (import.meta.main) console.log(`ports ${PORT_BASE}–${PORT_BASE + SPAN - 1} for ${ROOT}`);
