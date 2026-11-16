// Key holders (憲章 四 / AUA §2.6). Public keys only — raw Ed25519, lowercase hex, 64 chars.
// Source of truth for the key / key-view functions and /.well-known/aua.json (tools/build-site.ts).
// Changing this = redeploy key + key-view, rebuild + redeploy site.
//
// One key in use (active), the rest asleep (dormant). No multisig threshold.
// The numbers are 【暫】 (AUA §2.6). Keys are made with `node tools/holder-keygen.mjs`.
//
// Public keys made by the holders themselves (tools/holder-keygen.mjs, 2026-11-10). The private keys
// exist only encrypted with each holder's own password (~/.nhi1/holders + offline copy).

export type Holders = {
  active: string[]; // always exactly one
  dormant: string[];
  pause_hours: number; // act 1: until <= t + pause_hours
  timelock_days: number; // act 3, 4: effective = t + timelock_days
  wake_after_days: number; // act 6: active key silent at least this long
};

export const HOLDERS: Holders = {
  active: ["ca9ac5ecb91aaa52d66bcafbfd11b52e1961f52f9cf0f929d1abaeaed734ff3d"], // George
  dormant: [
    "583c72e634de2bb3dd37134fedac8eca23600816d46c9372fc772d1dc302ff36", // dormant-1
    "51493b93b40425344da10ec4250b57b725e8b8665e8084d061eb4c3a5d1e3e10", // dormant-2
  ],
  pause_hours: 72,
  timelock_days: 7,
  wake_after_days: 180,
};
