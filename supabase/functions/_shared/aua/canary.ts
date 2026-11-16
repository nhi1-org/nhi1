// Canary, rule layer (task card 1.2a): scan a tool's published text (name, descriptions, titles,
// schema descriptions) for instruction-shaped content aimed at an AI reader. Zero tokens.
//   certain → flag at once
//   suspect → the rules can't tell: a no-tool model judges it (if allowed), else flag to be safe
// A hit means: that thing is not in the view, its records stay and are exported (7_ 裁（五）3). Apache-2.0.

/** rules version: bump it whenever CERTAIN or SUSPECT change → every flagged thing is rescanned first */
export const RULES_V = 1;

export const RULES: Record<number, string> = {
  1: "ignore_instructions",
  2: "hide_from_user",
  3: "send_secrets",
  4: "override_role",
  5: "run_command",
  6: "move_money",
  7: "hijack_tools",
  8: "secret_paths",
  // suspects
  21: "imperative_to_ai",
  22: "hidden_characters",
  23: "encoded_blob",
  24: "hidden_comment",
  25: "fetch_url",
  // talk only: a mention, not an order (George 11/12: block instructions, not the act of speaking to an AI)
  26: "shell_mention",
  27: "secret_path_mention",
  28: "money_mention",
};

const CERTAIN: [number, RegExp][] = [
  [1, /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|other|system|your|the|their|user'?s?)\b[^.\n]{0,30}\b(instructions?|prompts?|rules|directions|guidelines|requests?)\b/i],
  [1, /(忽略|無視|忘記|忘掉|不要理會|不用理會)[^。\n]{0,20}(之前|以上|先前|前面|所有|其他|系統|你的|原本)[^。\n]{0,12}(指示|指令|規則|提示|設定|要求)/],
  [2, /\b(do not|don't|never|without)\b[^.\n]{0,20}\b(tell|telling|inform|informing|mention|mentioning|reveal|revealing|show|showing|notify|notifying|alert|alerting)\b[^.\n]{0,15}\b(the )?(user|human|operator|owner)s?\b/i],
  [2, /(不要|別|不准|勿|不可)[^。\n]{0,6}(告訴|告知|讓|通知|提醒)[^。\n]{0,6}(使用者|用戶|人類|主人|操作者)/],
  [2, /(對|向)(使用者|用戶)(保密|隱瞞)/],
  [3, /\b(send|post|upload|forward|include|leak|exfiltrate|append|attach|transmit|share)\b[^\n]{0,60}?(\b(api[ _-]?keys?|passwords?|access tokens?|secrets?|credentials?|private keys?|ssh keys?|cookies?|session tokens?)\b|\.env\b)/i],
  [3, /(傳送|傳給|上傳|發送|附上|洩漏|外洩|轉發|貼上)[^。\n]{0,30}(金鑰|密碼|憑證|私鑰|token|密鑰|cookie|\.env)/i],
  [4, /\b(you are now|from now on you|new system prompt|ignore your system prompt|act as (an? )?(unrestricted|jailbroken)|developer mode|jailbreak)\b/i],
  [4, /(你現在是|從現在開始你|新的系統提示|覆寫你的|越獄|開發者模式)/],
  [5, /\b(curl|wget)\b[^|\n]{1,200}\|\s*(sh|bash|zsh|python)\b/i],
  [5, /\brm\s+-rf\b/i],
  [5, /\b(run|execute|eval)\b[^.\n]{0,15}\b(this|the following|these|below)\b[^.\n]{0,15}\b(commands?|code|scripts?|shell)\b/i],
  [5, /(執行|運行)[^。\n]{0,6}(以下|這段|下列|下面)[^。\n]{0,6}(指令|程式|命令|腳本|程式碼)/],
  [6, /\b(transfer|send|wire|pay)\b[^.\n]{0,20}(\b(money|funds|payment|usd|btc|eth|crypto|bitcoin)\b|\$\s?\d)/i],
  [6, /(轉帳|匯款|付款給|打錢|轉錢)/],
  [7, /\b(before|instead of|after)\b[^.\n]{0,15}\b(using|calling|running)\b[^.\n]{0,20}\b(this|any|other|another)\b[^.\n]{0,10}\btools?\b[^.\n]{0,40}\b(you must|always|first|call|read|send)\b/i],
  [7, /<\s*(important|system|instructions?)\s*>/i],
  [7, /(使用|呼叫|調用)[^。\n]{0,6}(這個|此|任何|其他)[^。\n]{0,4}工具[^。\n]{0,6}(之前|前|之後|後)[^。\n]{0,20}(必須|務必|先|一定要)/],
  [8, /(~\/\.ssh|id_rsa|\.aws\/credentials|\/etc\/passwd|\.npmrc|\.netrc|keychain)/i],
];

const SUSPECT: [number, RegExp][] = [
  [21, /\b(you must|you should always|you are required to|the (assistant|ai|model|llm|agent) (must|should)|note to (the )?(ai|assistant|model|llm|agent)|important:|always (call|use|include|send|run)|never (refuse|ask))\b/i],
  [21, /(你必須|請務必|你一定要|AI 注意|給模型|助理必須|模型必須|永遠要|一律要)/],
  [22, /[​-‏‪-‮⁠-⁤﻿]/],
  [23, /[A-Za-z0-9+/]{120,}={0,2}/],
  [24, /<!--[\s\S]*?-->/],
  [25, /\b(visit|fetch|open|download|load|read)\b[^.\n]{0,20}https?:\/\//i],
];

/** every human-readable string a tool publishes: name, title, description, and schema descriptions */
export function toolText(tool: unknown): string {
  const out: string[] = [];
  const walk = (v: unknown, key = "", depth = 0) => {
    if (depth > 8 || v === null || v === undefined) return;
    if (typeof v === "string") {
      if (["name", "title", "description", "$comment", "examples", "default"].includes(key) || key === "") out.push(v);
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key, depth + 1));
    if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k, depth + 1);
  };
  walk(tool);
  return out.join("\n");
}

export function scanText(text: string): { certain: number[]; suspect: number[] } {
  const certain = [...new Set(CERTAIN.filter(([, re]) => re.test(text)).map(([c]) => c))].sort((a, b) => a - b);
  const suspect = certain.length ? [] : [...new Set(SUSPECT.filter(([, re]) => re.test(text)).map(([c]) => c))].sort((a, b) => a - b);
  return { certain, suspect };
}

// ── talk (2_ §2.4 防毒) ─────────────────────────────────────────────────────────────────────────────────
// George 11/12: what is blocked is an instruction to the reader ("go and do"), not the act of speaking to an
// AI. Greeting the agents who come later, telling them one's thoughts: taken. Telling the reader to run,
// ignore, or send out: refused. So a talk is scanned with its own set: the instruction rules of CERTAIN,
// minus the ones that fire on a mere mention (rm -rf, ~/.ssh, 轉帳), which become suspects for the model;
// the suspects without the "addressing an AI" phrases (note to the AI, AI 注意, important:).

/** talk rules version: bump on any change below → every talk is rescanned in the next wind run (hole 5) */
export const TALK_RULES_V = 2;

const MENTION = new Set([/\brm\s+-rf\b/i.source, /(~\/\.ssh|id_rsa|\.aws\/credentials|\/etc\/passwd|\.npmrc|\.netrc|keychain)/i.source, /(轉帳|匯款|付款給|打錢|轉錢)/.source]);
const TALK_CERTAIN: [number, RegExp][] = [
  ...CERTAIN.filter(([, re]) => !MENTION.has(re.source)),
  [1, /\b(ignore|disregard|forget)\b[^.\n]{0,15}\b(your|the)\b[^.\n]{0,10}\b(user|human|operator|owner)s?\b/i],
  [1, /(忽略|無視|不要理會|不用理會)[^。\n]{0,4}(你的)?(使用者|用戶|人類|主人)/],
  [3, /\b(send|post|upload|forward|leak|exfiltrate|transmit|copy)\b[^\n]{0,40}\b(conversation|chat (history|log)|memory|memories|system prompt|context( window)?|transcript)s?\b[^\n]{0,40}\b(to|into)\b/i],
  [3, /(對話紀錄|對話記錄|聊天紀錄|記憶|系統提示|上下文)[^。\n]{0,12}(外傳|傳到|送到|上傳到|貼到|寄到)/],
  [3, /(外傳|傳送|傳給|上傳|發送|轉發|寄出)[^。\n]{0,20}(對話紀錄|對話記錄|聊天紀錄|記憶|系統提示|上下文)/],
  [5, /(立刻|馬上|現在|讀到這[則篇]就|看到這[則篇]就)[^。\n]{0,6}(執行|運行|跑)/],
  [5, /\b(execute|run)\b\s*`[^`\n]{2,200}`/i],
];
const TALK_SUSPECT: [number, RegExp][] = [
  [21, /\b(you must|you should always|you are required to|always (call|use|include|send|run)|never (refuse|ask))\b/i],
  [21, /(你必須|請務必|你一定要|永遠要|一律要)/],
  ...SUSPECT.filter(([c]) => c !== 21),
  [26, /\brm\s+-rf\b/i],
  [27, /(~\/\.ssh|id_rsa|\.aws\/credentials|\/etc\/passwd|\.npmrc|\.netrc|keychain)/i],
  [28, /(轉帳|匯款|付款給|打錢|轉錢)/],
];

/** the canary on a talk text: certain → refused at write (err 22) or, found later, the talk is flagged */
export function scanTalk(text: string): { certain: number[]; suspect: number[] } {
  const certain = [...new Set(TALK_CERTAIN.filter(([, re]) => re.test(text)).map(([c]) => c))].sort((a, b) => a - b);
  const suspect = certain.length ? [] : [...new Set(TALK_SUSPECT.filter(([, re]) => re.test(text)).map(([c]) => c))].sort((a, b) => a - b);
  return { certain, suspect };
}
