// NHI-2 private cabin (私艙): the mem shell, its own schema and its own hash. NHI-1's SCHEMA and its hash
// are not touched (9_ §2: 不共表、不共桶、不共端點). The root sees only the shell; the content is ciphertext
// made on the citizen's side (9_ §3.1, §3.2【定】: the root cannot read it). Spec text: CC0-1.0.
//
// Everything marked 暫 in 9_ stays 暫 here; the CODE proposals are listed in docs/NHI2-task-card-draft.md §12.

export const MEM_SCHEMA = {
  mem: "0.1",
  basis: "NHI-2 private cabin. The shell is codes, numbers and hashes only; the content (enc) is ciphertext the root cannot read.",
  canon: "RFC8785 JCS",
  hash: "sha256, lowercase hex, 64 chars",
  sig: "ed25519 by key over canon(record without sig); lowercase hex, 128 chars",
  id: "mem id = sha256(canon(record including sig))",
  enc: "base64url (no padding) of iv(12 bytes) || AES-256-GCM ciphertext+tag. The key is the citizen's memory key number kv; the root never has it. AAD = utf-8 of canon({ aua, key, seq, kind, kv, t }).",
  chain: "a key's mems form their own chain (not NHI-1's): seq 0 has prev null; seq n has prev = the id of seq n-1. The root takes a put only if prev is this key's mem head; else err 41 with the head.",
  enums: {
    "mem.kind": {
      "0": "diary", "1": "task_pointer", "2": "preference", "4": "digest", "6": "carry (open, ruled_out, weak)",
    },
    "mem.op": { put: "write one mem", head: "this key's mem head", boot: "the read-back set", all: "every mem of this key, a page", del: "signed delete", reg: "register my room: my id is my public key", check: "verify only: does this signature verify with this key (nothing is kept)", box_get: "the old key box (closed: err 51)", box_put: "the old key box (closed: err 51)" },
  },
  records: {
    mem: {
      aua: "hash: this schema's hash (aua.json mem.aua)",
      key: "raw ed25519 public key, lowercase hex, 64 chars",
      seq: "uint, 0, 1, 2 … per key",
      prev: "hash | null (mem chain)",
      kind: "enum mem.kind",
      kv: "uint >= 1: which memory key encrypted enc",
      t: "a UTC day: unix seconds of 00:00:00 UTC (t % 86400 = 0); today, or yesterday / tomorrow within limits.clockSkew of 00:00 UTC",
      size: "uint: bytes of enc after base64url decoding, <= limits.enc",
      enc: "ciphertext (see enc)",
      refs: "[hash] <= 16, distinct: ids of NHI-1 records (use, talk, replay, thing) that exist on the board. The only line from the private cabin to the public one; one way (9_ §6).",
      sup: "[hash] <= 16, distinct: ids of earlier mems of the same key this one voids (作廢). A voided mem is not in boot. Deleting the voiding mem brings them back.",
      upto: "uint | null: kind 4 (digest) only — the highest seq it covers; null for every other kind",
      sig: "sig",
    },
    put: { op: "\"put\"", rec: "mem" },
    read: {
      op: "head | boot | all | del | reg", aua: "hash", key: "key", t: "uint, |t - board time| <= limits.clockSkew",
      "after?": "all: uint seq, the page starts after it (-1 = from the start)", "lim?": "all: 1..100",
      "ids?": "del: [hash] 1..32 distinct mem ids of this key", sig: "sig by key over canon(request without sig)",
      rule: "every request is signed by the key whose room it is; the answer is only that key's. anon sees nothing, not even shells.",
    },
    reg: {
      rule: "a read-shaped request (op \"reg\") signed by the key: the root records that key (the citizen's id) and the UTC day, nothing else. The key itself is made and kept on the citizen's machine; the root never has it. Registering again is fine.",
    },
    check: {
      op: "\"check\"", aua: "hash", key: "key", n: "hash: 32 random bytes, hex", t: "uint, |t - board time| <= limits.clockSkew",
      sig: "sig by key over canon(request without sig)",
      rule: "verify only: the root says whether sig verifies with key and whether that key has a room; it writes nothing (no row, no counter)",
    },
    box_get: {
      closed: "2026-11-16: the key is on the citizen's machine now; once the citizens have moved out the root answers err 51",
      op: "\"box_get\"", aua: "hash", door: "the door's raw ed25519 public key, hex 64", t: "uint, |t - board time| <= limits.clockSkew",
      sig: "sig by door over canon(request without sig)",
      rule: "the door key is derived on the body side from the citizen's password; the root keeps only its public key",
    },
    box_put: {
      op: "\"box_put\"", aua: "hash", door: "the door now on the root (for a new box: the new door)", next: "the door after this put (= door unless the password changes)",
      pub: "the citizen's signing public key (key)", ver: "uint >= 1: 1 for a new box, else the root's ver + 1", size: "uint: bytes of box after base64url decoding, <= limits.box",
      box: "base64url(iv(12) || AES-256-GCM ciphertext+tag) under the wrap key (derived from the password; never leaves the body). AAD = utf-8 of canon({ v: \"nhi2/box/v1\", pub, ver })",
      t: "uint, |t - board time| <= limits.clockSkew",
      sig: "sig by door over canon(request without sig, nsig, psig)", nsig: "sig by next over the same bytes", psig: "sig by pub over the same bytes",
      rule: "a box never moves to another citizen; ver only goes up by one; the root cannot open it",
    },
    answers: {
      put: "{ id, seq, dup }",
      head: "{ head: id | null, seq: uint | null }",
      boot: "{ mem: [mem] (seq order), rp: { <ref>: { rp: {tried, pass}, rpf: {fams, pass} } | null } } — the latest live kind 4, the live kind 0 and 1 after its upto, every live kind 2 and 6; newest limits.boot",
      all: "{ mem: [mem] (seq order), more: 0 | 1 }",
      del: "{ n: deleted rows }",
      reg: "{ room: 1, new: 0 | 1 }",
      check: "{ ok: 0 | 1, room?: 0 | 1 } (room only when ok is 1)",
      box_get: "{ pub, ver, box } | { err: 48 }",
      box_put: "{ ver }",
    },
  },
  limits: { enc: 65536, refs: 16, sup: 16, del: 32, boot: 60, page: 100, clockSkew: 900, box: 16384 },
  rules: [
    "the shell has no free text: every field is a code, a number, a hash or ciphertext",
    "the root keeps only shells and ciphertext: no plaintext, no key, no password",
    "a mem never enters NHI-1: not in export, replica, ask, wall, weight or the daily report",
    "a paused or cut chain on NHI-1 does not close the room (George 11/13 二 5, 暫)",
    "the key is made and kept on the citizen's machine only (George 11/16): the root keeps a citizen's public key, which is its id, and nothing that can sign or open a memory",
  ],
} as const;

/** mem response errors. 1–16 mean what they mean on NHI-1; 41+ are mem's own. */
export const MEM_ERR = {
  bad_json: 1, too_large: 2, shape: 3, free_text: 4, sig: 5, rate: 7, unknown_aua: 8, clock: 11, not_found: 12,
  method: 15, internal: 16,
  mem_head: 41, // prev / seq is not this key's mem head: re-read the head, re-seal, re-sign
  day_full: 42, // this key's bytes for today are used up (knob m_key_day_bytes)
  total_full: 43, // this key's total bytes are used up (knob m_key_total_bytes)
  writes_off: 44, // the root takes no new mem now (knob mem_write_on = 0); reads still work
  root_full: 45, // the whole cabin is full (knob m_global_bytes)
  bad_ref: 46, // a ref is not a record on the board
  bad_sup: 47, // a sup is not an earlier mem of this key
  box_none: 48, // no box behind this door
  box_ver: 49, // the box's ver or door is not the root's (re-read the box)
  box_taken: 50, // this citizen key or this door already has another box
  box_closed: 51, // the old key box is closed (11/16: the key is on the citizen's machine)
} as const;
