// Usage limits for coding-agent subscriptions, as T3 Code reads and shows them: in the status bar one
// icon and what's left per provider that has at least one limit window; a click opens an AI-Quota-style
// card with every provider together, each with its ring of what's left, its plan badge (when the API
// reports one), its refills time and every window. In the sidebar (props.node: this block's layout id)
// a heading folds the rows to one line and the block fits them, hidden when no provider has a window.
// Percents and bars show what's left (100 minus T3's used); opening the card reads again.
//
// What each provider reads, after T3's own probes:
//   Claude Code  `claude -p` asked `get_usage` over stream-json, as T3's SDK probe: the CLI uses its own login.
//   Codex        `codex app-server` asked `account/rateLimits/read`; else the newest rollout's `rate_limits`.
//   OpenCode     the OpenCode Go key (auth.json or opencode.db) sent only to opencode.ai's usage endpoint.
//   Antigravity  acp_token.json's refresh token sent only to Google: oauth2, then cloudcode-pa quota.
//   Grok Build   ~/.grok/auth.json's x.ai login key sent only to cli-chat-proxy.grok.com's billing endpoint.
//   Cursor       a file login (~/.cursor/auth.json) sent only to api2.cursor.sh. The default macOS login is in the
//                Keychain, which T3 reads only when asked; a mod row can't ask, so a Keychain login has no row.
// Pi and Muse Code have no row: T3 reads only Pi's token usage, and Muse's limits only from a live session's 429.
// Credentials stay in the reader that sends them: never stored, shown, logged or shared.
// Claude and Codex also keep saved accounts (accounts.js), each read with its own home; see the card.

import { View, div, svg, image, PathBuilder, Background } from "gpui-kit";
import { v_flex, h_flex, Popover, InputState, Input } from "gpui-base";
import { exec, readTextFile, watchFolder, home, appHome, theme, props, run, shared, setShared, focused, openOverlay, notify, nextCommand } from "herdr";
import { accountsDir, validAccount, activeAccount, accountArgv } from "./accounts.js";

// T3's order and colors (usageProviders.ts), except Codex: T3 uses the contrast foreground, but a
// tinted single color keeps the ring and gradient legible, so Codex gets its own green.
const PROVIDERS = [
  { key: "codex", label: "Codex", color: "#4cc38a", icon: "mods/t3-limits/icons/codex.svg", tint: true },
  { key: "claude", label: "Claude Code", color: "#d97757", icon: "mods/t3-limits/icons/claude.svg", tint: true },
  // T3's Grok is 72% of the contrast foreground: the theme's muted.
  { key: "grok", label: "Grok Build", color: "muted", icon: "mods/t3-limits/icons/grok.svg", tint: true },
  { key: "cursor", label: "Cursor", color: "#8b8b8b", icon: "mods/t3-limits/icons/cursor.svg", tint: true },
  { key: "opencode", label: "OpenCode", color: "#5b9bbd", icon: "mods/t3-limits/icons/opencode.svg", tint: true },
  { key: "antigravity", label: "Antigravity", color: "#8c7bd1", icon: "mods/t3-limits/icons/antigravity.svg", tint: true },
];
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
// Read every 5 minutes; a failing provider waits twice as long each time, up to an hour.
const POLL = 5 * MINUTE, MAX_WAIT = HOUR;
// A click reads again unless the last read is this fresh.
const CLICK_GAP = 30000;
// Sidebar heights: heading, a row each, the space under the last.
const HEAD = 26, ROW = 20, FOOT = 6;
// The unified card's ring: what's left, 0-100, around the tightest window's remainder.
const RING = 54;
const WARN = 75, NEAR = 90;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// One window, T3's ServerProviderUsageWindow with times in ms: used 0-100, resetsAt null when unknown.
function win(id, label, used, resetsAt, mins) {
  const pct = Number.isFinite(used) ? Math.max(0, Math.min(100, used)) : 0;
  return { id, label, used: pct, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null, mins: mins ?? null };
}
const isoMs = (s) => (typeof s === "string" ? Date.parse(s) : NaN);
const secMs = (n) => (typeof n === "number" && n > 0 ? n * 1000 : NaN);
const num = (n) => typeof n === "number" && Number.isFinite(n);

// A plan name fit for a badge: short plain text, else nothing. Providers that don't report one get no badge.
function planName(s) {
  if (typeof s !== "string") return null;
  const t = s.trim().replace(/\s+/g, " ").slice(0, 16);
  return /^[A-Za-z0-9][A-Za-z0-9 .+-]*$/.test(t) ? t : null;
}
const upperPlan = (s) => { const p = planName(s); return p ? p.toUpperCase() : null; };
// Lighten a #rrggbb toward white for a gradient tail; null when it isn't a hex literal
// (paint_path only takes #rgb/#rrggbb/#rrggbbaa, never theme names).
function lightEnd(hex, k = 0.55) {
  const m = typeof hex === "string" && hex.match(/^#([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const mix = (i) => Math.round(parseInt(m[1].slice(i, i + 2), 16) + (255 - parseInt(m[1].slice(i, i + 2), 16)) * k);
  return `#${[0, 2, 4].map(mix).map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
// Codex reports a planType id; these are the display names. Anything else shows uppercased, never invented.
const CODEX_PLANS = { free: "FREE", go: "GO", plus: "PLUS", team: "TEAM", business: "BUSINESS", enterprise: "ENTERPRISE", edu: "EDU" };

// Claude's get_usage reply (percent already 0-100), as claudeUsageResponseToLimits. null: no subscription windows.
function claudeWindows(r) {
  if (!r?.rate_limits_available || !r.rate_limits) return null;
  const rl = r.rate_limits, out = [];
  for (const [id, label, mins] of [["five_hour", "5h", 300], ["seven_day", "Weekly", 10080]]) {
    const w = rl[id];
    if (num(w?.utilization)) out.push(win(id, label, w.utilization, isoMs(w.resets_at), mins));
  }
  for (const e of Array.isArray(rl.model_scoped) ? rl.model_scoped : []) {
    if (typeof e?.display_name !== "string" || !num(e.utilization)) continue;
    const id = `seven_day_${e.display_name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    out.push(win(id, `Weekly · ${e.display_name}`, e.utilization, isoMs(e.resets_at), 10080));
  }
  const spend = claudeSpend(rl);
  if (spend !== null) out.push(win("monthly_spend", "Monthly spend", spend, NaN));
  out.plan = upperPlan(r.subscription_type);
  return out;
}

// The monthly spend budget, else extra usage, as readSpendPercent: minor units only compare in one currency.
function claudeSpend(rl) {
  const ratio = (used, limit) => (num(used) && num(limit) && used >= 0 && limit > 0 ? (used / limit) * 100 : null);
  const s = rl.spend;
  if (s?.enabled === true && s.used?.currency?.trim() && s.used.currency.trim() === s.limit?.currency?.trim()
    && s.used.exponent === s.limit.exponent) {
    const p = ratio(s.used.amount_minor, s.limit.amount_minor);
    if (p !== null) return p;
  }
  const x = rl.extra_usage;
  if (x?.is_enabled !== true) return null;
  const p = ratio(x.used_credits, x.monthly_limit) ?? x.utilization;
  return num(p) && p >= 0 ? p : null;
}

// The stream-json reply: only the get_usage answer is read; the rest (account, commands) is dropped unread.
function claudeReply(stdout) {
  for (const line of stdout.split("\n")) {
    if (!line.includes('"request_id":"usage"')) continue;
    const d = JSON.parse(line).response;
    if (d?.subtype !== "success") throw new Error(String(d?.error ?? "Claude did not answer"));
    return claudeWindows(d.response);
  }
  throw new Error("Claude did not answer");
}

// A Codex snapshot (app-server camelCase), as codexRateLimitsToWindows: primary/secondary are positions,
// and without a window length paid plans mean 5h/weekly, Free and Go monthly. The snapshot's planType
// rides on the windows for the badge.
function codexWindows(snap) {
  if (!snap || (snap.limitId && snap.limitId !== "codex")) return [];
  const monthly = snap.planType === "free" || snap.planType === "go", out = [];
  for (const [id, w, fallback] of [["primary", snap.primary, monthly ? 43200 : 300], ["secondary", snap.secondary, 10080]]) {
    if (!w || !num(w.usedPercent)) continue;
    const mins = num(w.windowDurationMins) ? w.windowDurationMins : fallback;
    const label = mins >= 43200 ? "Monthly" : mins >= 10080 ? "Weekly" : `${Math.round(mins / 60)}h`;
    out.push(win(id, label, w.usedPercent, secMs(w.resetsAt), mins));
  }
  const ind = snap.individualLimit;
  if (ind && num(ind.remainingPercent)) out.push(win("individual", "Monthly credit limit", 100 - ind.remainingPercent, secMs(ind.resetsAt)));
  out.plan = CODEX_PLANS[snap.planType] ?? upperPlan(snap.planType);
  return out;
}

// account/rateLimits/read's result: the main allowance by its id, else the snapshot.
function codexReply(result) {
  return codexWindows(result?.rateLimitsByLimitId?.codex ?? result?.rateLimits);
}

// A rollout's token_count event (snake_case, as written to ~/.codex/sessions), into the same snapshot.
function codexRollout(line) {
  const p = JSON.parse(line)?.payload, r = p?.type === "token_count" ? p.rate_limits : null;
  if (!r) return null;
  const w = (x) => x && { usedPercent: x.used_percent, windowDurationMins: x.window_minutes, resetsAt: x.resets_at };
  const ind = r.individual_limit;
  return codexWindows({ limitId: r.limit_id, planType: r.plan_type, primary: w(r.primary), secondary: w(r.secondary),
    individualLimit: ind && { remainingPercent: ind.remaining_percent, resetsAt: ind.resets_at } });
}

// OpenCode Go's /usage body, as readOpenCodeGoUsageLimits.
function opencodeWindows(body) {
  const u = body?.usage;
  if (!u) throw new Error("OpenCode Go returned no usage");
  return [["go_rolling", "5h", u.rolling, 300], ["go_weekly", "Weekly", u.weekly, 10080], ["go_monthly", "Monthly", u.monthly, null]]
    .filter(([, , w]) => num(w?.percent))
    .map(([id, label, w, mins]) => win(id, label, w.percent, isoMs(w.resetsAt), mins));
}

// Grok's billing body, as grokUsageResponseToLimits: one subscription window for its period.
// The body's subscriptionTier (when sent) rides on the windows for the badge.
function grokWindows(body) {
  const period = body?.config?.currentPeriod, type = period?.type?.replace(/^USAGE_PERIOD_TYPE_/, "");
  const label = type === "WEEKLY" ? "Weekly" : type === "MONTHLY" ? "Monthly" : "Subscription";
  let used = body?.config?.creditUsagePercent;
  // Grok leaves out a zero percent but keeps the whole period.
  // ponytail: Date.parse, not T3's strict ISO check; a malformed period just reads as no window.
  if (used === undefined && label !== "Subscription" && isoMs(period?.start) < isoMs(period?.end)) used = 0;
  const out = num(used) ? [win("subscription", label, used, isoMs(period?.end), type === "WEEKLY" ? 10080 : null)] : [];
  out.plan = planName(body?.subscriptionTier ?? body?.subscription_tier);
  return out;
}

// Cursor's GetCurrentPeriodUsage body, as cursorUsageResponseToLimits: the plan's pools for this billing cycle.
function cursorWindows(body) {
  const end = Number(body?.billingCycleEnd);
  return [["totalPercentUsed", "Overall"], ["autoPercentUsed", "Cursor Models"], ["apiPercentUsed", "Other Models"]]
    .filter(([id]) => num(body?.planUsage?.[id]))
    .map(([id, label]) => win(id, label, body.planUsage[id], end > 0 ? end : NaN));
}

// Antigravity quotas are what's left (0-1).
function quotaWindow(id, label, q, mins) {
  return num(q?.remainingFraction) ? win(id, label, (1 - Math.max(0, Math.min(1, q.remainingFraction))) * 100, isoMs(q.resetTime), mins) : null;
}

// retrieveUserQuotaSummary, as summaryWindows: buckets by family; an untouched bucket's reset is just "a full window
// from now", so it has none.
function antigravitySummary(summary, requestedAt) {
  const out = new Map();
  const groups = summary?.groups?.some((g) => g.buckets?.length) ? summary.groups : [{ buckets: summary?.buckets }];
  for (const g of groups) {
    for (const b of g.buckets ?? []) {
      if (b.disabled || typeof b.bucketId !== "string" || !b.bucketId) continue;
      const group = g.displayName?.trim();
      const family = b.bucketId.startsWith("gemini-argon-") ? group || "Gemini Argon"
        : b.bucketId.startsWith("gemini-") ? "Gemini" : b.bucketId.startsWith("3p-") ? "Claude & GPT (shared)" : group || b.bucketId;
      const mins = { "5h": 300, weekly: 10080 }[b.window] ?? null;
      const untouched = b.remainingFraction === 1 && b.description === undefined && mins !== null
        && Math.abs(isoMs(b.resetTime) - requestedAt - mins * MINUTE) <= MINUTE;
      const kind = b.window === "weekly" ? "Weekly" : b.window === "5h" ? "5h" : b.displayName?.trim() || "Quota";
      const w = quotaWindow(b.bucketId, `${family} · ${kind}`, { ...b, resetTime: untouched ? undefined : b.resetTime }, mins);
      if (w) out.set(w.id, w);
    }
  }
  return [...out.values()];
}

// fetchAvailableModels, for older accounts: per family, the most used; no window length is invented.
function antigravityModels(body) {
  const out = new Map();
  for (const [id, m] of Object.entries(body?.models ?? {})) {
    const p = m?.modelProvider ?? "";
    const family = p === "MODEL_PROVIDER_GOOGLE" || id.startsWith("gemini-") ? "Gemini"
      : p === "MODEL_PROVIDER_ANTHROPIC" || id.startsWith("claude-") ? "Claude"
      : p === "MODEL_PROVIDER_OPENAI" || id.startsWith("gpt-") ? "GPT" : null;
    if (!family) continue;
    for (const [suffix, q] of [["quota", m.quotaInfo], ["weekly", m.weeklyQuotaInfo]]) {
      const weekly = suffix === "weekly";
      const w = q && quotaWindow(`${family.toLowerCase()}-${suffix}`, `${family} · ${weekly ? "Weekly" : "Reported quota"}`, q, weekly ? 10080 : null);
      if (w && !(out.get(w.id)?.used >= w.used)) out.set(w.id, w);
    }
  }
  return [...out.values()];
}

// Both endpoints' windows, each id at its most used.
function mostUsed(lists) {
  const out = new Map();
  for (const w of lists.flat()) if (!(out.get(w.id)?.used >= w.used)) out.set(w.id, w);
  return [...out.values()];
}

// A window that has reset since it was read is empty again.
const usedNow = (w, now) => (w.resetsAt !== null && w.resetsAt <= now ? 0 : w.used);

// The window closest to its limit.
function tightest(windows, now) {
  let best = null;
  for (const w of windows ?? []) if (!best || usedNow(w, now) > usedNow(best, now)) best = w;
  return best;
}

// T3's formatDuration: 2d 4h, 4h 12m, 12m.
function duration(ms) {
  const left = Math.max(0, ms), d = Math.floor(left / DAY), h = Math.floor((left % DAY) / HOUR), m = Math.floor((left % HOUR) / MINUTE);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function resetsIn(w, now) {
  return !w || w.resetsAt === null ? "" : w.resetsAt <= now ? "now" : duration(w.resetsAt - now);
}
// The exact time: Thu Nov 5, 07:59.
function exactTime(ms) {
  const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// --- Readers. Each resolves to windows, null (present, nothing to read), or throws (keep the last good ones).

// Which providers this machine has: their CLI on PATH or their data folder.
const DETECT = [
  'for p in claude codex opencode grok; do command -v "$p" >/dev/null 2>&1 && echo "$p"; done',
  '{ [ -f "$HOME/.cursor/auth.json" ] || [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/cursor/auth.json" ]; } && echo cursor',
  '[ -f "$HOME/.grok/auth.json" ] && echo grok',
  '[ -d "${CODEX_HOME:-$HOME/.codex}/sessions" ] && echo codex',
  '[ -d "${XDG_DATA_HOME:-$HOME/.local/share}/opencode" ] && echo opencode',
  '{ [ -d "$HOME/.gemini/antigravity" ] || [ -f "$HOME/.gemini/antigravity-acp/acp_token.json" ] || command -v agy >/dev/null 2>&1; } && echo antigravity',
  "true",
].join("\n");
async function detect() {
  const r = await exec("sh", ["-c", DETECT], { cwd: home() });
  return new Set(r.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
}

// T3's capabilities probe: no prompt reaches the model, hooks and MCP servers stay off, nothing is saved.
// `exec` makes the shell become claude, so a timeout that stops it stops claude too.
const CLAUDE = [
  "export ENABLE_CLAUDEAI_MCP_SERVERS=false CLAUDE_CODE_AUTO_CONNECT_IDE=0 CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=1",
  "exec claude -p --input-format stream-json --output-format stream-json --verbose --no-session-persistence " +
    `--settings '{"disableAllHooks":true}' --strict-mcp-config --mcp-config '{"mcpServers":{}}' <<'EOF'`,
  '{"type":"control_request","request_id":"init","request":{"subtype":"initialize"}}',
  '{"type":"control_request","request_id":"usage","request":{"subtype":"get_usage","skip_behaviors":true}}',
  "EOF",
].join("\n");
// An account's home comes in as $1, never in the script's text.
async function readClaude(dir) {
  const r = await exec("sh", ["-c", `if [ -n "$1" ]; then export CLAUDE_CONFIG_DIR="$1"; fi\n${CLAUDE}`, "sh", dir ?? ""], { cwd: home() });
  return claudeReply(r.stdout);
}

// codex app-server answers only while its input is open: it reads a fifo the shell holds open until the answer
// is in (10 s at most). On any exit, or when stopped, the shell kills it and removes its files.
const CODEX = [
  "command -v codex >/dev/null 2>&1 || exit 127",
  'd=$(mktemp -d) || exit 1',
  'mkfifo "$d/in" || exit 1',
  'codex app-server <"$d/in" >"$d/out" 2>/dev/null &',
  "pid=$!",
  'stop() { kill "$pid" 2>/dev/null; rm -rf "$d"; }',
  "trap stop EXIT",
  "trap 'exit 1' TERM INT HUP",
  'exec 3>"$d/in"',
  "printf '%s\\n' " + [
    '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"t3-limits","title":"t3-limits","version":"1.0.0"}}}',
    '{"method":"initialized"}',
    '{"id":2,"method":"account/rateLimits/read"}',
  ].map((s) => `'${s}'`).join(" ") + " >&3",
  `i=0; while [ $i -lt 100 ] && ! grep -q '"id":2' "$d/out"; do sleep 0.1; i=$((i+1)); done`,
  `grep '"id":2' "$d/out"`,
].join("\n");
// The newest rollout (their paths sort by start time) and its last rate_limits line.
const ROLLOUT = [
  `f=$(find "\${CODEX_HOME:-$HOME/.codex}/sessions" -name 'rollout-*.jsonl' -type f 2>/dev/null | sort | tail -1)`,
  `[ -n "$f" ] && grep '"rate_limits"' "$f" | tail -1`,
].join("\n");
// T3's auth overlay (CodexHomeLayout): an account's home links what the default home already has, but not its login,
// so config, sessions and skills stay shared. Nothing is made in the default home: a folder it lacks is made in the
// account's own. It only adds what's missing, so it runs before each use.
const CODEX_SHADOW = [
  'src="${CODEX_HOME:-$HOME/.codex}"; dst="$1"; mkdir -p "$dst" || exit 1',
  'for e in "$src"/* "$src"/.[!.]*; do',
  '  [ -e "$e" ] || [ -L "$e" ] || continue; n=${e##*/}',
  '  case "$n" in auth.json|auth.lock|models_cache.json|log|memories|tmp|.DS_Store) continue;; esac',
  '  [ -e "$dst/$n" ] || [ -L "$dst/$n" ] || ln -s "$e" "$dst/$n"',
  'done',
  'for n in sessions archived_sessions sqlite shell_snapshots worktrees skills plugins cache logs; do',
  '  [ -e "$dst/$n" ] || [ -L "$dst/$n" ] || mkdir "$dst/$n"',
  'done',
].join("\n");
// Rollouts are shared between accounts, so they stand in only while Codex has no saved accounts.
async function readCodex(dir, rollout = true) {
  if (dir) await exec("sh", ["-c", CODEX_SHADOW, "sh", dir], { cwd: home() });
  const live = await exec("sh", ["-c", `if [ -n "$1" ]; then export CODEX_HOME="$1"; fi\n${CODEX}`, "sh", dir ?? ""], { cwd: home() }).catch(() => null);
  const line = live?.stdout.split("\n").find((l) => l.includes('"id":2'));
  const reply = line ? JSON.parse(line) : null;
  if (reply?.result) return codexReply(reply.result);
  if (dir || !rollout) throw new Error(reply?.error?.message ?? "Codex did not report usage");
  const old = await exec("sh", ["-c", ROLLOUT], { cwd: home() });
  const windows = old.stdout.trim() ? codexRollout(old.stdout.trim()) : null;
  if (!windows) throw new Error(reply?.error?.message ?? "Codex did not report usage");
  return windows;
}

// OpenCode Go's keys, in T3's order: opencode.db's selected Console connections, then auth.json's Go key.
async function opencodeKeys() {
  const dir = `${home()}/.local/share/opencode`, keys = [];
  const db = await exec("sqlite3", ["-readonly", "-json", "-cmd", ".timeout 100", `${dir}/opencode.db`,
    "SELECT integration_id AS id, value FROM credential WHERE integration_id IN ('opencode','opencode-go') AND active IS NOT 0 ORDER BY integration_id, active DESC, time_created DESC, id DESC"])
    .catch(() => null);
  const rows = db?.code === 0 && db.stdout.trim() ? JSON.parse(db.stdout) : [];
  for (const id of ["opencode", "opencode-go"]) {
    const row = rows.find((r) => r.id === id);
    let v = null;
    try { v = JSON.parse(row?.value ?? "null"); } catch {}
    // A self-hosted or OAuth connection is not opencode.ai's: never send its key there.
    const server = v?.metadata?.server;
    const ours = typeof server !== "string" || server.replace(/\/+$/, "") === "https://opencode.ai/console";
    if (v?.type === "key" && typeof v.key === "string" && v.key.trim() && ours) keys.push(v.key.trim());
  }
  const text = await readTextFile(`${dir}/auth.json`).catch(() => null);
  let go = null;
  try { go = JSON.parse(text ?? "{}")["opencode-go"]; } catch {}
  if (go?.type === "api" && typeof go.key === "string" && go.key.trim()) keys.push(go.key.trim());
  return [...new Set(keys)];
}
async function readOpencode() {
  const keys = await opencodeKeys();
  for (const key of keys) {
    const r = await fetch("https://opencode.ai/zen/go/v1/usage", { headers: { Authorization: `Bearer ${key}` } });
    // A Zen key can exist without a Go subscription.
    if (r.status === 401 || r.status === 403) continue;
    if (!r.ok) throw new Error(`OpenCode Go answered ${r.status}`);
    return opencodeWindows(await r.json());
  }
  return null;
}

// Antigravity's ACP login (GEMINI_HOME's file storage), or the agy CLI's own login
// (macOS Keychain's gemini/antigravity entry): a fresh access token each read, held only for that read.
const QUOTA_HOSTS = ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"];
// The Keychain holds a go-keyring-base64 OAuth token. The shell prints only its
// access token, so the refresh token never leaves the Keychain.
const AGY_KEYCHAIN = [
  "out=$(security find-generic-password -s gemini -a antigravity -w 2>/dev/null) || exit 1",
  "printf '%s' \"$out\" | sed 's/^go-keyring-base64://' | python3 -c 'import json,sys,base64; print(json.loads(base64.b64decode(sys.stdin.read().strip())).get(\"token\",{}).get(\"access_token\",\"\"))'",
].join("\n");
async function agyAccessToken() {
  const r = await exec("sh", ["-c", AGY_KEYCHAIN]).catch(() => null);
  const t = (r?.stdout ?? "").trim();
  return t || null;
}
// One quota read against both hosts, keeping each window's most-used reading.
async function antigravityAsk(access, project, op, parse) {
  const at = Date.now();
  const out = await Promise.all(QUOTA_HOSTS.map(async (host) => {
    const r = await fetch(`${host}/v1internal:${op}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json", "User-Agent": "antigravity/hub/2.24.0 (aidev_client)" },
      body: JSON.stringify(project ? { project } : {}),
    }).catch(() => null);
    return r?.ok ? parse(await r.json(), at) : [];
  }));
  return mostUsed(out);
}
async function antigravityWindows(access, project) {
  const windows = await antigravityAsk(access, project, "retrieveUserQuotaSummary", antigravitySummary);
  return windows.length ? windows : antigravityAsk(access, project, "fetchAvailableModels", antigravityModels);
}
// The agy CLI path: no prompt reaches a model. On empty windows the token may have
// expired, so `agy models` runs once to let the CLI refresh its own login, then the
// Keychain is read again. Nothing is kept past the read.
async function readAntigravityCli() {
  let access = await agyAccessToken();
  if (!access) return null;
  let windows = await antigravityWindows(access, null);
  if (!windows.length) {
    await exec("agy", ["models"], { timeout: 15000 }).catch(() => null);
    access = await agyAccessToken();
    if (access) windows = await antigravityWindows(access, null);
  }
  if (!windows.length) throw new Error("Antigravity returned no quota");
  return windows;
}
async function readAntigravity() {
  const text = await readTextFile(`${home()}/.gemini/antigravity-acp/acp_token.json`).catch(() => null);
  if (!text) return readAntigravityCli();
  const tok = JSON.parse(text);
  if (![tok.client_id, tok.client_secret, tok.refresh_token].every((s) => typeof s === "string" && s)) return null;
  const form = { client_id: tok.client_id, client_secret: tok.client_secret, refresh_token: tok.refresh_token, grant_type: "refresh_token" };
  const t = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: Object.entries(form).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&"),
  });
  const access = t.ok ? (await t.json())?.access_token : null;
  if (typeof access !== "string" || !access) throw new Error("Google refused the Antigravity login");
  const found = await antigravityWindows(access, tok.project_id);
  if (!found.length) throw new Error("Antigravity returned no quota");
  return found;
}

// Grok's x.ai login, as readGrokCredential: a config that picks another account or endpoint, or an API-key login,
// is left to the CLI, and no account but x.ai's two is read from the file.
const GROK_ACCOUNTS = ["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828", "https://accounts.x.ai/sign-in"];
const GROK_CUSTOM = /^\s*(?:\[\[?\s*)?["']?(?:auth|grok_com_config|endpoints)["']?\s*[.\]=]/m;
async function readGrok() {
  const dir = `${home()}/.grok`;
  for (const f of ["config.toml", "managed_config.toml", "requirements.toml"].map((n) => `${dir}/${n}`)
    .concat(["/etc/grok/managed_config.toml", "/etc/grok/requirements.toml"])) {
    if (GROK_CUSTOM.test((await readTextFile(f).catch(() => null)) ?? "")) return null;
  }
  let creds = {};
  try { creds = JSON.parse((await readTextFile(`${dir}/auth.json`).catch(() => null)) ?? "{}") ?? {}; } catch {}
  const c = creds[GROK_ACCOUNTS[0]] ?? creds[GROK_ACCOUNTS[1]];
  const key = c?.auth_mode === "api_key" || typeof c?.key !== "string" ? "" : c.key.trim();
  if (!key) return null;
  const r = await fetch("https://cli-chat-proxy.grok.com/v1/billing?format=credits", { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`Grok answered ${r.status}`);
  return grokWindows(await r.json());
}

// Cursor's file login (the CLI with AGENT_CLI_CREDENTIAL_STORE=file, or Linux). Never the Keychain.
// The plan name lives on GetPlanInfo under the same login; without it there's just no badge.
async function readCursor() {
  let token = "";
  for (const f of [`${home()}/.cursor/auth.json`, `${home()}/.config/cursor/auth.json`]) {
    try { token = JSON.parse((await readTextFile(f).catch(() => null)) ?? "{}")?.accessToken?.trim() ?? ""; } catch {}
    if (token) break;
  }
  if (!token) return null;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "connect-protocol-version": "1", "x-cursor-client-type": "cli" };
  const r = await fetch("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
    method: "POST", headers, body: "{}",
  });
  if (!r.ok) throw new Error(`Cursor answered ${r.status}`);
  const out = cursorWindows(await r.json());
  const p = await fetch("https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo", {
    method: "POST", headers, body: "{}",
  }).catch(() => null);
  const info = p?.ok ? await p.json().catch(() => null) : null;
  out.plan = planName(info?.planInfo?.planName);
  return out;
}

const READERS = { claude: readClaude, codex: readCodex, grok: readGrok, cursor: readCursor, opencode: readOpencode, antigravity: readAntigravity };

// Each provider's own login, run in a new account's home (claude --help, codex --help), and the file it writes there.
const LOGIN = { claude: ["claude", "auth", "login"], codex: ["codex", "login"] };
const LOGIN_FILE = { claude: ".claude.json", codex: "auth.json" };
// While a login runs, its home is read at most this often: the read itself writes files there.
const LOGIN_GAP = 15000;
// A remove confirm is good for this long, and only for the command carrying its nonce.
const CONFIRM_TTL = 60000;
const STORE = "limits.accounts";
const keyOf = (provider, id) => (id ? `${provider}:${id}` : provider);
const copy = (x) => JSON.parse(JSON.stringify(x ?? {}));

// An id from the label, unique among the provider's: "Work" is work, then work-2.
function slug(label, taken) {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "account";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

// The store with an account added, made active, or removed (removing the active one falls back to Default).
function withAccount(store, provider, account) {
  const next = copy(store), s = (next[provider] ??= { active: null, accounts: [] });
  s.accounts.push(account);
  return next;
}
function withActive(store, provider, id) {
  const next = copy(store);
  (next[provider] ??= { active: null, accounts: [] }).active = id;
  return next;
}
function withoutAccount(store, provider, id) {
  const next = copy(store), s = next[provider];
  if (!s) return next;
  s.accounts = (s.accounts ?? []).filter((a) => a.id !== id);
  if (s.active === id) s.active = null;
  return next;
}

export default class Limits extends View {
  init(_props, cx) {
    // key ("claude", or "claude:<account id>") -> { windows (null or []: nothing), plan (the subscription
    // badge, or null), checkedAt, error, failures, nextAt }.
    // Only windows, plan and times are cached.
    this.state = {};
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem("cache") ?? "{}") ?? {}; } catch {}
    for (const [key, c] of Object.entries(cache)) {
      if (READERS[key.split(":")[0]]) this.state[key] = { windows: c.windows ?? null, plan: c.plan ?? null, checkedAt: c.checkedAt ?? null, error: null, failures: 0, nextAt: 0 };
    }
    this.present = new Set(Object.keys(this.state).map((k) => k.split(":")[0]));
    this.collapsed = localStorage.getItem("collapsed") === "true";
    // The unified card's page, the provider display order, and how many providers the status
    // bar shows. Order and count persist on this machine; the page does not.
    this.view = "card";
    const keys = PROVIDERS.map((p) => p.key);
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem("order") ?? "null"); } catch {}
    const kept = Array.isArray(saved) ? saved.filter((k) => keys.includes(k)) : [];
    this.order = [...kept, ...keys.filter((k) => !kept.includes(k))];
    const max = Number(localStorage.getItem("maxItems"));
    this.maxItems = Number.isInteger(max) && max >= 1 ? max : 99;
    // The card width, draggable at its corner; the height stays content-driven.
    const cardW = Number(localStorage.getItem("cardW"));
    this.cardW = Number.isInteger(cardW) && cardW >= 1 ? Math.max(240, Math.min(520, cardW)) : 310;
    const cardH = Number(localStorage.getItem("cardH"));
    this.cardH = Number.isInteger(cardH) && cardH >= 1 ? Math.max(200, Math.min(700, cardH)) : null;
    this.resizing = null;
    // The open card's provider, the one being given a new account, and the account a confirm will remove.
    this.openKey = null;
    this.adding = null;
    this.removing = null;
    this.label = InputState.new({ placeholder: "Account name, e.g. Work" });
    this.label.on("submit", (_e, cx) => this.addAccount(this.adding, cx));
    // Only t3-new-menu starts agents with the chosen account: without it there's no choice to offer.
    this.launcher = false;
    cx.spawn(async (cx) => {
      this.launcher = Boolean(await readTextFile(`${appHome()}/mods/t3-new-menu/accounts.js`).catch(() => null));
      cx.notify();
    });
    this.fit();
    cx.timer.every(POLL, (cx) => this.refresh(cx));
    // The reset times count down by the minute.
    cx.timer.every(MINUTE, (cx) => cx.notify());
    // Follows the pointer while a corner drag is held; idle otherwise.
    cx.timer.every(50, (cx) => this.trackResize(cx));
    // The confirm dialog runs t3-limits.remove-<nonce>.
    cx.spawn(async (cx) => {
      for (;;) {
        await this.command(await nextCommand());
        cx.notify();
      }
    });
    this.refresh(cx);
  }

  // Only entries naming this mod's own folders: others in shared state are ignored.
  accounts(provider) {
    return LOGIN[provider] ? (shared(STORE)?.[provider]?.accounts ?? []).filter((a) => validAccount(provider, a)) : [];
  }

  // What to read: each present provider's default home, and Claude's and Codex's saved accounts.
  targets() {
    return [...this.present].filter((p) => READERS[p]).flatMap((p) => [
      { key: p, provider: p, dir: null },
      ...this.accounts(p).map((a) => ({ key: keyOf(p, a.id), provider: p, dir: a.home })),
    ]);
  }

  async read({ key, provider, dir }) {
    const s = (this.state[key] ??= { windows: null, plan: null, checkedAt: null, error: null, failures: 0, nextAt: 0 });
    try {
      s.windows = await READERS[provider](dir, !this.accounts(provider).length);
      // The plan rides with a good read and stays with the last good windows through a failure.
      if (s.windows) s.plan = Array.isArray(s.windows) ? s.windows.plan ?? null : null;
      Object.assign(s, { checkedAt: Date.now(), error: null, failures: 0, nextAt: Date.now() + POLL });
    } catch (e) {
      s.failures++;
      s.error = String(e?.message ?? e).slice(0, 120);
      s.nextAt = Date.now() + Math.min(POLL * 2 ** s.failures, MAX_WAIT);
    }
  }

  save() {
    const cache = {};
    for (const { key } of this.targets()) if (this.state[key]?.checkedAt) cache[key] = { windows: this.state[key].windows, plan: this.state[key].plan ?? null, checkedAt: this.state[key].checkedAt };
    localStorage.setItem("cache", JSON.stringify(cache));
  }

  // Reads every target that's due (or all of provider `only`, now). One round at a time.
  refresh(cx, only = null) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        this.present = await detect().catch(() => this.present);
        const now = Date.now();
        await Promise.all(this.targets().filter((t) => (only ? t.provider === only || t.key === only : !(this.state[t.key]?.nextAt > now))).map((t) => this.read(t)));
        this.save();
      } finally {
        this.busy = false;
      }
      this.fit();
      cx.notify();
    });
  }

  // The window a row shows: the active account's, else Default's, else any account's that has one.
  shown(p) {
    const active = activeAccount(shared(STORE), p.key);
    const order = [active, null, ...this.accounts(p.key)].map((a) => ({ key: keyOf(p.key, a?.id), label: a?.label ?? "Default" }));
    return order.find((o) => this.state[o.key]?.windows?.length) ?? null;
  }

  // Providers show in the saved order, in the sidebar, the strip and the card alike.
  // Order is per account ("codex", "claude:work", ...); provider order is first appearance.
  accountKeys() {
    const out = [];
    for (const p of PROVIDERS) {
      out.push(p.key);
      for (const a of this.accounts(p.key)) out.push(keyOf(p.key, a.id));
    }
    return out;
  }
  orderAccounts() {
    const cur = this.accountKeys();
    const kept = this.order.filter((k) => cur.includes(k));
    const out = [...kept];
    // A new account joins right after its provider's own entries, not at the very end.
    for (const k of cur.filter((k) => !kept.includes(k))) {
      const pk = k.split(":")[0];
      let at = out.length;
      for (let i = 0; i < out.length; i++) if (out[i].split(":")[0] === pk) at = i + 1;
      out.splice(at, 0, k);
    }
    return out;
  }
  providerOrder() {
    const seen = [];
    for (const k of this.orderAccounts()) {
      const p = k.split(":")[0];
      if (!seen.includes(p)) seen.push(p);
    }
    return seen;
  }
  // Order rows list only providers with data or saved accounts, never the whole catalogue.
  orderRows() {
    const have = new Set(this.rows().map((p) => p.key));
    const out = [];
    for (const k of this.orderAccounts()) {
      const pk = k.split(":")[0];
      if (!have.has(pk) && !this.accounts(pk).length) continue;
      if (!out.includes(k)) out.push(k);
    }
    return out;
  }
  rows() {
    const at = new Map(this.providerOrder().map((k, i) => [k, i]));
    return PROVIDERS.filter((p) => this.present.has(p.key) && this.shown(p))
      .sort((a, b) => (at.get(a.key) ?? 99) - (at.get(b.key) ?? 99));
  }

  // The display order and the strip count, both kept on this machine.
  saveOrder() {
    localStorage.setItem("order", JSON.stringify(this.order));
  }
  move(key, dir, cx) {
    const list = this.orderAccounts();
    const i = list.indexOf(key), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    this.order = list;
    this.saveOrder();
    cx.notify();
  }
  setMax(n, cx) {
    this.maxItems = Math.max(1, Math.min(PROVIDERS.length, n));
    localStorage.setItem("maxItems", String(this.maxItems));
    cx.notify();
  }
  setCardW(w) {
    this.cardW = Math.max(240, Math.min(520, Math.round(w)));
    localStorage.setItem("cardW", String(this.cardW));
  }
  setCardH(h) {
    this.cardH = Math.max(200, Math.min(700, Math.round(h)));
    localStorage.setItem("cardH", String(this.cardH));
  }
  // Corner-drag resizing: a fast timer follows the pointer while held. It stops on release,
  // after 10s, or after 1.5s without movement, so a missed mouse-up can't stick it.
  // The pointer's position, or null outside a live host call (a viewless timer tick, ...).
  mouseXY() {
    try {
      const mp = window.mouse_position ? window.mouse_position() : null;
      return mp && typeof mp.x === "number" && typeof mp.y === "number" ? mp : null;
    } catch { return null; }
  }
  beginResize(cx, axes = "xy") {
    const mp = this.mouseXY();
    if (!mp) return;
    // The drag starts from what the list shows now; without a stored height, opening the
    // card just follows the provider count, and the first vertical drag pins it.
    const visible = this.visibleHeight ?? null;
    this.resizing = { x0: mp.x, y0: mp.y, w0: this.cardW, h0: this.cardH ?? visible ?? 320, axes, seenX: mp.x, seenY: mp.y, at: Date.now() };
    cx.notify();
  }
  trackResize(cx) {
    if (!this.resizing || !this.open) { this.resizing = null; return; }
    try {
      const now = Date.now();
      const mp = this.mouseXY();
      if (!mp || now - this.resizing.at > 10000) { this.resizing = null; return; }
      const r = this.resizing;
      if (mp.x !== r.seenX || mp.y !== r.seenY) { r.seenX = mp.x; r.seenY = mp.y; r.at = now; }
      else if (now - r.at > 1500) { this.resizing = null; return; }
      // The left edge: dragging left (smaller x) grows the card.
      if (r.axes !== "y") this.setCardW(r.w0 - (mp.x - r.x0));
      // The top edge: dragging up (smaller y) grows the card.
      if (r.axes !== "x") this.setCardH(r.h0 - (mp.y - r.y0));
    } catch { this.resizing = null; return; }
    cx.notify();
  }
  endResize(cx) {
    if (this.resizing) { this.resizing = null; cx.notify(); }
  }

  // The sidebar block is as tall as what it shows, and hidden when nothing has a window.
  fit() {
    const node = props()?.node;
    if (!node) return;
    const n = this.rows().length, px = !n ? 0 : this.collapsed ? HEAD + 2 : HEAD + n * ROW + FOOT;
    if (px === this.px) return;
    if (!px) run("layout.hide", { id: node });
    else {
      if (!this.px) run("layout.show", { id: node });
      run("layout.resize", { id: node, px });
    }
    this.px = px;
  }

  // The status bar's trigger opens every provider together: a click reads again unless all are fresh
  // (refresh itself reads only what's due). Same same-press guard as toggle().
  toggleBar(open, cx) {
    const now = Date.now();
    this.resizing = null;
    if (open) {
      if (this.shutBar && now - this.shutBar < 400) return;
      this.open = true;
      this.adding = null;
      // Back at the card: a confirm left open or cancelled can't remove anything any more.
      this.removing = null;
      this.refresh(cx);
    } else if (this.open) {
      this.open = false;
      this.shutBar = now;
    }
    cx.notify();
  }

  // A manual read: everything is due, then the usual one round.
  refreshAll(cx) {
    for (const t of this.targets()) {
      const s = (this.state[t.key] ??= { windows: null, plan: null, checkedAt: null, error: null, failures: 0, nextAt: 0 });
      s.nextAt = 0;
    }
    this.refresh(cx);
  }

  // A press on the open row's trigger closes its card. The card's own outside-press close can land first in that
  // same press and the trigger then asks to open again: that reopen is ignored.
  toggle(provider, open, cx) {
    const now = Date.now();
    if (open) {
      if (this.shut?.key === provider && now - this.shut.at < 400) return;
      this.openKey = provider;
      this.adding = null;
      // Back at a card: a confirm left open or cancelled can't remove anything any more.
      this.removing = null;
      if (!(this.state[provider]?.checkedAt > now - CLICK_GAP)) this.refresh(cx, provider);
    } else if (this.openKey === provider) {
      this.openKey = null;
      this.shut = { key: provider, at: now };
    }
    cx.notify();
  }

  // Makes the account's home, then runs the provider's own login there in a new tab of this space. Its bars appear
  // once the login has written into that home. The mod never sees the credentials.
  addAccount(provider, cx) {
    const label = this.label.value().trim();
    if (!LOGIN[provider] || !label) return;
    const id = slug(label, this.accounts(provider).map((a) => a.id)), account = { id, label, home: `${accountsDir(provider)}/${id}` };
    this.adding = null;
    this.openKey = null;
    cx.spawn(async (cx) => {
      const made = await exec("sh", ["-c", provider === "codex" ? CODEX_SHADOW : 'mkdir -p "$1"', "sh", account.home]).catch(() => null);
      if (made?.code !== 0) {
        notify({ title: "Could not add the account", body: `Couldn't create ${account.home}.`, level: "error" });
        return;
      }
      setShared(STORE, withAccount(shared(STORE), provider, account));
      const space = focused()?.space;
      run("tab.new", { ...(space ? { space } : {}), name: `${label} login`, argv: accountArgv(provider, account, LOGIN[provider]) });
      cx.notify();
      // Read again when the login writes its file, at most every 15s and through refresh's one-round guard. Reading
      // writes files in the home too, so any other change is ignored.
      const key = keyOf(provider, id), login = `${account.home}/${LOGIN_FILE[provider]}`;
      let last = 0;
      while (!this.state[key]?.windows?.length && this.accounts(provider).some((a) => a.id === id)) {
        const changed = await watchFolder(account.home);
        if (!changed.some((f) => f === login || f === account.home) || Date.now() - last < LOGIN_GAP) continue;
        last = Date.now();
        this.refresh(cx, key);
      }
    });
  }

  askRemove(provider, account) {
    // ponytail: Math.random nonce; it only has to be unguessable by a key binding or another mod's run().
    const nonce = Array.from({ length: 16 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
    this.removing = { provider, id: account.id, nonce, at: Date.now() };
    this.openKey = null;
    openOverlay({
      mod: "confirm", kind: "dialog", width: 400, height: 180,
      props: {
        title: `Remove ${account.label}?`,
        detail: `Deletes its home folder, ${account.home}, and the login stored in it. The default login and running agents aren't touched.`,
        command: { name: `t3-limits.remove-${nonce}` },
      },
    });
  }

  // A remove runs only from the confirm it was asked with: its nonce, within a minute. Anything else disarms it.
  async command(c) {
    if (!String(c).startsWith("remove")) return;
    const m = /^remove-([0-9a-f]{16})$/.exec(c), r = this.removing;
    this.removing = null;
    if (m && r && r.nonce === m[1] && Date.now() - r.at < CONFIRM_TTL) await this.remove(r);
  }

  // Deletes only a folder this mod made under its accounts folder, never a CLI's own home.
  async remove(r) {
    const account = this.accounts(r.provider).find((a) => a.id === r.id);
    if (!account) return;
    await exec("rm", ["-rf", "--", account.home]).catch(() => null);
    setShared(STORE, withoutAccount(shared(STORE), r.provider, r.id));
    delete this.state[keyOf(r.provider, r.id)];
    this.save();
    this.fit();
  }

  render(cx) {
    const t = theme(), now = Date.now(), sidebar = Boolean(props()?.node);
    // What's left, 0-100, of a window; percents and bars show this, and it wears the color.
    const left = (w) => 100 - usedNow(w, now);
    const tone = (rem) => (rem <= 100 - NEAR ? t.blocked : rem <= 100 - WARN ? t.ansi3 : null);
    const colorOf = (p) => (p.color === null ? t.foreground : t[p.color] ?? p.color);
    const icon = (p, size) => (p.tint ? svg(p.icon).size(size).text_color(colorOf(p)) : image(p.icon).w(size).h(size)).flex_none();
    const bar = (p, w, h) => {
      const rem = left(w), base = tone(rem) ?? colorOf(p), tail = lightEnd(base);
      const track = div().flex_1().min_w(0).h(h).rounded(h).bg(t.border).overflow_hidden();
      const pct = `${Math.round(rem)}%`;
      // A painted gradient (angle 90: left to right) when the color is a hex literal.
      // Guarded: a paint_path this build can't do must not take the view down, so anything
      // unexpected falls back to the solid fill.
      let fill = null;
      if (tail) {
        try {
          fill = window.paint_path(
            PathBuilder.fill().move_to(0, 0).line_to("100%", 0).line_to("100%", "100%").line_to(0, "100%").close().build(),
            Background.linear_gradient(90, base, tail)
          ).w(pct).h_full();
        } catch { fill = null; }
      }
      if (!fill) fill = div().h_full().rounded(h).bg(base).w(pct);
      return track.child(fill.transition("width", { duration: 300, easing: "ease-out" }));
    };
    const link = (id, text, act) => div().id(id).h(20).px(5).flex().flex_none().items_center().rounded(4).text_size(10).text_color(t.dim)
      .hover((st) => st.bg(t.hover).text_color(t.foreground)).role("button")
      .on_click((_e, cx) => { cx.stop_propagation(); act(cx); cx.notify(); }).child(text);
    // The subscription badge: the plan in the provider's color, only when the API reported one.
    const badge = (p, plan) => div().id(`limits-badge-${p.key}`).flex_none().px(6).py(1).rounded(5).bg(t.raised).text_size(9).text_color(colorOf(p)).child(plan);
    // When the whole was read, as the card footer.
    const updated = (ms) => { const d = new Date(ms), pad = (n) => String(n).padStart(2, "0"); return `Updated ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

    // Every window, with its exact reset.
    const windows = (p, key) => (this.state[key]?.windows ?? []).map((w) => v_flex().gap(3)
      .child(h_flex().gap(8)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(w.label))
        .child(div().flex_none().text_size(11).text_color(tone(left(w)) ?? t.foreground).child(`${Math.round(left(w))}%`)))
      .child(h_flex().child(bar(p, w, 4)))
      .when(w.resetsAt !== null, (el) => el.child(div().text_size(11).text_color(t.dim)
        .child(w.resetsAt <= now ? `Reset ${exactTime(w.resetsAt)}` : `Resets in ${resetsIn(w, now)} · ${exactTime(w.resetsAt)}`))));

    // One provider's accounts (Claude and Codex) or its windows: shared by the sidebar card and the unified card.
    const providerList = (p) => {
      const multi = Boolean(LOGIN[p.key]);
      const list = multi ? [{ id: null, label: "Default" }, ...this.accounts(p.key)] : [{ id: null, label: p.label }];
      const at = new Map(this.orderAccounts().map((k, i) => [k, i]));
      list.sort((a, b) => (at.get(keyOf(p.key, a.id)) ?? 99) - (at.get(keyOf(p.key, b.id)) ?? 99));
      return { multi, active: activeAccount(shared(STORE), p.key)?.id ?? null, list };
    };
    // The plan of the shown account, for the badge.
    const shownPlan = (p) => this.state[this.shown(p)?.key]?.plan ?? null;
    // The add-account row, link and launcher note, shared by both card styles.
    const addRow = (p) => h_flex().h(28).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.input)
      .child(Input.new(this.label).flex_1().h_full().text_size(12).text_color(t.foreground))
      .child(link(`limits-add-go-${p.key}`, "Add", (cx) => this.addAccount(p.key, cx)));
    const addLink = (p) => link(`limits-add-${p.key}`, "+ Add account", () => {
      this.adding = p.key;
      this.label.set_value("");
      this.label.focus();
    });
    const launcherNote = div().text_size(9.5).text_color(t.dim).child("The checked account applies to new agents from the New menu. Running agents keep theirs.");
    const statusOf = (p) => (a) => {
      const s = this.state[keyOf(p.key, a.id)];
      return s?.windows?.length ? null : !s?.checkedAt ? (s?.error ? `Could not read: ${s.error}` : "Reading…")
        : a.id ? "Not signed in yet: finish the login in its tab." : "No limits to read.";
    };
    const section = (p) => {
      const { multi, active, list } = providerList(p), status = statusOf(p), plan = shownPlan(p);
      return v_flex().id(`limits-section-${p.key}`).gap(6)
        .child(h_flex().gap(8).items_center().child(icon(p, 14)).child(div().flex_1().font_medium().text_color(t.foreground).child(p.label))
          .when(plan, (el) => el.child(badge(p, plan))))
        .children(list.map((a) => {
          const key = keyOf(p.key, a.id);
          return v_flex().id(`limits-account-${key}`).gap(6)
            .when(multi, (el) => el.child(h_flex().h(20).gap(6).items_center()
              .child(this.launcher && a.id === active ? svg("mods/workspace-chrome/check.svg").size(10).flex_none().text_color(t.accent) : div().w(10).flex_none())
              .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(a.label))
              .when(this.launcher && a.id !== active, (el) => el.child(link(`limits-use-${key}`, "Use for new agents", () => setShared(STORE, withActive(shared(STORE), p.key, a.id)))))
              .when(Boolean(a.id), (el) => el.child(link(`limits-remove-${key}`, "Remove", () => this.askRemove(p.key, a))))))
            .children(windows(p, key))
            .when(Boolean(status(a)), (el) => el.child(div().text_size(10).text_color(t.dim).child(status(a))));
        }))
        .when(multi && this.adding === p.key, (el) => el.child(addRow(p)))
        .when(multi && this.adding !== p.key, (el) => el.child(addLink(p)))
        .when(multi && this.launcher, (el) => el.child(launcherNote));
    };
    // One window in the unified card: label, short reset and what's left over its bar.
    // One window: a quiet label, the reset, then the number in the foreground so the eye
    // lands on percentages; the bar sits under them as a hairline of color.
    const winrow = (p, w) => v_flex().gap(5)
      .child(h_flex().gap(8).items_baseline()
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.muted).child(w.label))
        .child(div().flex_none().text_size(9.5).text_color(t.dim).child(resetsIn(w, now)))
        .child(div().flex_none().w(32).text_right().text_size(10.5).font_medium().text_color(tone(left(w)) ?? t.foreground).child(`${Math.round(left(w))}%`)))
      .child(bar(p, w, 5));
    // One provider as its own card: the ring of what's left beside the name, plan and refills,
    // then every window of the shown account, then (Claude and Codex) its accounts.
    const providerCard = (p, showKey) => {
      const wins = this.state[showKey]?.windows ?? [];
      const tight = tightest(wins, now), rem = tight ? Math.round(left(tight)) : 0;
      const refill = tight && resetsIn(tight, now) ? `refills ${resetsIn(tight, now)}` : "";
      const plan = this.state[showKey]?.plan ?? null;
      const step = Math.max(0, Math.min(100, Math.round(rem / 5) * 5));
      const { multi, list } = providerList(p), status = statusOf(p);
      return v_flex().id(`limits-section-${p.key}`).gap(9).px(13).py(12).rounded(12).bg(t.raised).border_1().border_color(t.border)
        .on_size_change((size, _cx) => { (this.measured ??= {})[p.key] = size.height; })
        .child(h_flex().gap(12)
          .child(div().id(`limits-ring-${p.key}`).relative().w(RING).h(RING).flex_none()
            .child(svg("mods/t3-limits/icons/rings/track.svg").size(RING).absolute().left(0).top(0).text_color(t.border))
            .child(svg(`mods/t3-limits/icons/rings/r${String(step).padStart(2, "0")}.svg`).size(RING).absolute().left(0).top(0).text_color(colorOf(p)))
            .child(div().absolute().left(0).top(0).w(RING).h(RING).flex().items_center().justify_center()
              .child(div().text_size(13).font_medium().text_color(t.foreground).child(`${rem}%`))))
          .child(v_flex().flex_1().min_w(0).gap(6)
            .child(h_flex().gap(6).items_center()
              .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12.5).text_color(t.foreground).child(p.label))
              .when(plan, (el) => el.child(badge(p, plan)))
              .child(div().flex_none().text_size(9.5).text_color(t.dim).child(refill)))
            .children(wins.map((w) => winrow(p, w)))))
        .when(multi, (el) => el.children(list.filter((a) => keyOf(p.key, a.id) !== showKey).map((a) => {
          const key = keyOf(p.key, a.id);
          return v_flex().id(`limits-account-${key}`).gap(4)
            .child(div().text_size(10.5).text_color(t.dim).child(a.label))
            .children(windows(p, key))
            .when(Boolean(status(a)), (el) => el.child(div().text_size(10).text_color(t.dim).child(status(a))));
        })));
    };
    const readFooter = (keys) => {
      const read = Math.max(0, ...keys.map((k) => this.state[k]?.checkedAt ?? 0));
      const failed = keys.some((k) => this.state[k]?.error);
      return read > 0 ? [div().text_size(11).text_color(t.dim)
        .child(`${updated(read)}${failed ? " · a read failed, retrying" : ""}`)] : [];
    };

    // The sidebar card: one provider's section, then when it was read.
    const card = (p) => v_flex().id(`limits-card-${p.key}`).w(300).p(10).gap(10).rounded(10).bg(t.popover).border_1().border_color(t.border).text_size(12)
      .on_click((_e, cx) => cx.stop_propagation())
      .child(section(p))
      .children(readFooter(providerList(p).list.map((a) => keyOf(p.key, a.id))));

    // A 24px icon button for the card title rows.
    const iconBtn = (id, icon, tip, act) => div().id(id).size(22).rounded(6).flex().items_center().justify_center().tooltip(tip)
      .hover((st) => st.bg(t.hover)).role("button")
      .on_click((_e, cx) => { cx.stop_propagation(); act(cx); cx.notify(); })
      .child(svg(icon).size(13).text_color(t.muted));
    // The status bar's card: the quota page and the settings page side by side in a frame,
    // sliding left to settings. The provider list is as tall as its estimate, up to a cap,
    // so many accounts scroll instead of running off the window. Dragged edges are the
    // two away from the bottom-right anchor: the top grows the list, the left the card.
    const W = this.cardW, innerW = W;
    const estCard = (p, showKey) => {
      const n = (this.state[showKey]?.windows ?? []).length;
      const { multi, list } = providerList(p);
      return 24 + Math.max(RING, 22 + n * 34) + (multi ? list.length * 24 + 36 : 0);
    };
    const AUTO_H = (rows) => Math.min(520, Math.max(0, rows.reduce((h, p) => h + (this.measured?.[p.key] ?? estCard(p, this.shown(p).key)) + 10, -10)));
    const listH = this.cardH ?? AUTO_H(this.rows());
    const unified = (rows) => {
      const allKeys = rows.flatMap((p) => providerList(p).list.map((a) => keyOf(p.key, a.id)));
      const read = Math.max(0, ...allKeys.map((k) => this.state[k]?.checkedAt ?? 0));
      const failed = allKeys.some((k) => this.state[k]?.error);
      const oRows = this.orderRows();
      const listed = new Set(oRows.map((k) => k.split(":")[0]));
      const quotaPage = v_flex().w(innerW).flex_none().gap(12).px(14).pt(12).pb(10)
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(13).text_color(t.foreground).child("AI Quota"))
          .child(div().flex_none().text_size(9.5).text_color(t.dim)
            .child(read > 0 ? `${updated(read)}${failed ? " · retry" : ""}` : ""))
          .child(iconBtn("limits-refresh", "mods/t3-limits/icons/refresh.svg", "Read again", (cx) => this.refreshAll(cx)))
          .child(iconBtn("limits-gear", "mods/workspace-chrome/settings.svg", "Settings", () => { this.view = "settings"; })))
        .child(v_flex().id("limits-cards").flex_none().h(listH)
          .overflow_y_scrollbar().gap(10)
          .on_size_change((size, _cx) => { this.visibleHeight = size.height; })
          .children(rows.map((p) => providerCard(p, this.shown(p).key))));
      const sectionTitle = (text) => div().font_semibold().text_size(10).text_color(t.dim).child(text);
      const hairline = () => div().h(1).bg(t.border).flex_none();
      const settingsPage = v_flex().id("limits-settings").w(innerW).flex_none().gap(9).px(14).pt(12).pb(10)
        .child(h_flex().gap(6).items_center()
          .child(iconBtn("limits-back", "mods/workspace-chrome/chevron-left.svg", "Back", () => { this.view = "card"; }))
          .child(div().flex_1().font_semibold().text_size(13).text_color(t.foreground).child("Settings")))
        .child(sectionTitle("Order"))
        .child(v_flex().gap(1).px(8).py(4).rounded(10).bg(t.raised).border_1().border_color(t.border)
          .children(oRows.flatMap((k, i) => {
            const cut = k.indexOf(":"), pk = cut < 0 ? k : k.slice(0, cut);
            const p = PROVIDERS.find((x) => x.key === pk);
            const acc = cut < 0 ? null : this.accounts(pk).find((a) => a.id === k.slice(cut + 1));
            const row = h_flex().id(`limits-order-${k}`).gap(7).items_center().h(30)
              .child(icon(p, 12))
              .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.foreground)
                .child(acc ? `${p.label} · ${acc.label}` : p.label))
              .child(iconBtn(`limits-up-${k}`, "mods/t3-limits/icons/chevron-up.svg", "Move up", (cx) => this.move(k, -1, cx)))
              .child(iconBtn(`limits-down-${k}`, "mods/t3-limits/icons/chevron-down.svg", "Move down", (cx) => this.move(k, 1, cx)));
            return [...(i > 0 ? [hairline()] : []), row];
          })))
        .child(sectionTitle("Accounts"))
        .child(v_flex().gap(6).px(8).py(6).rounded(10).bg(t.raised).border_1().border_color(t.border)
          .children(["claude", "codex"].filter((pk) => listed.has(pk)).flatMap((pk, pi, arr) => {
            const p = PROVIDERS.find((x) => x.key === pk);
            const { active, list } = providerList(p), status = statusOf(p);
            return [
              ...(pi > 0 ? [hairline()] : []),
              h_flex().gap(7).items_center().pt(4).child(icon(p, 12))
                .child(div().flex_1().font_semibold().text_size(11).text_color(t.foreground).child(p.label)),
              ...list.map((a) => {
                const key = keyOf(pk, a.id);
                return v_flex().id(`limits-set-account-${key}`).gap(2)
                  .child(h_flex().h(24).gap(7).items_center()
                    .child(this.launcher && a.id === active ? svg("mods/workspace-chrome/check.svg").size(11).flex_none().text_color(t.accent) : div().w(11).flex_none())
                    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.foreground).child(a.label))
                    .when(this.launcher && a.id !== active, (el) => el.child(link(`limits-set-use-${key}`, "Use", () => setShared(STORE, withActive(shared(STORE), pk, a.id)))))
                    .when(Boolean(a.id), (el) => el.child(link(`limits-set-remove-${key}`, "Remove", () => this.askRemove(pk, a)))))
                  .when(Boolean(status(a)), (el) => el.child(div().text_size(11).text_color(t.dim).child(status(a))));
              }),
              this.adding === pk
                ? h_flex().h(28).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.input)
                  .child(Input.new(this.label).flex_1().h_full().text_size(12).text_color(t.foreground))
                  .child(link(`limits-set-add-go-${pk}`, "Add", (cx) => this.addAccount(pk, cx)))
                : h_flex().id(`limits-set-add-${pk}`).h(26).gap(7).items_center().rounded(6).role("button")
                  .hover((st) => st.bg(t.hover))
                  .on_click((_e, cx) => { cx.stop_propagation(); this.adding = pk; this.label.set_value(""); this.label.focus(); cx.notify(); })
                  .child(svg("mods/workspace-chrome/plus.svg").size(11).flex_none().text_color(t.dim))
                  .child(div().text_size(10.5).text_color(t.muted).child("Add account")),
              ...(this.launcher && pi === arr.length - 1 ? [launcherNote] : []),
            ];
          })))
        .child(sectionTitle("Status bar"))
        .child(v_flex().gap(2).p(8).rounded(12).bg(t.raised).border_1().border_color(t.border)
          .child(h_flex().gap(4).items_center().h(30)
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child("Show up to"))
            .child(iconBtn("limits-fewer", "mods/workspace-chrome/minus.svg", "Fewer", (cx) => this.setMax(this.maxItems - 1, cx)))
            .child(div().w(18).text_center().text_size(11).font_medium().text_color(t.foreground).child(`${Math.min(this.maxItems, listed.size)}`))
            .child(iconBtn("limits-more", "mods/workspace-chrome/plus.svg", "More", (cx) => this.setMax(this.maxItems + 1, cx)))));
      // Anchored bottom-right: the dragged edges are the top and the left, as in any panel
      // that grows away from its anchor. They are overlaid on the edge instead of taking layout
      // space, so the card stays symmetric.
      const edge = (id, tip, axes, vert) => div().id(id).absolute().tooltip(tip)
        .hover((st) => st.bg(t.hover)).role("button")
        .on_mouse_down("left", (_e, cx) => this.beginResize(cx, axes))
        .on_mouse_up("left", (_e, cx) => this.endResize(cx))
        .when(vert, (el) => el.left(0).top(0).bottom(0).w(6)).when(!vert, (el) => el.top(0).left(0).right(0).h(6));
      return v_flex().id("limits-card").relative().w(W).rounded(14).bg(t.popover).border_1().border_color(t.border).overflow_hidden().text_size(12)
        .on_click((_e, cx) => cx.stop_propagation())
        .child(v_flex().w(W).flex_none()
          .child(h_flex().w(innerW).flex_none().min_w(0)
            .child(h_flex().id("limits-slider").w(innerW * 2).flex_none().relative().items_start()
              .left(this.view === "settings" ? -innerW : 0)
              .transition("left", { duration: 200, easing: "ease-out" })
              .child(quotaPage).child(settingsPage))))
        .child(edge("limits-resize-t", "Drag to resize height", "y", false))
        .child(edge("limits-resize-l", "Drag to resize width", "x", true))
        .child(div().id("limits-resize-c").absolute().top(0).left(0).size(10).tooltip("Drag to resize")
          .role("button")
          .on_mouse_down("left", (_e, cx) => this.beginResize(cx, "xy"))
          .on_mouse_up("left", (_e, cx) => this.endResize(cx)));
    };

    const row = (p) => {
      const sh = this.shown(p), w = tightest(this.state[sh.key].windows, now), id = `limits-${p.key}`;
      const named = this.launcher && this.accounts(p.key).length > 0;
      const trigger = h_flex().id(id).h(ROW).gap(8).flex_none().items_center().rounded(4)
        .when(sidebar, (el) => el.pl(16).pr(12)).when(!sidebar, (el) => el.w(196).px(4))
        .when(this.openKey === p.key, (el) => el.bg(t.hover))
        .hover((st) => st.bg(t.hover)).role("button")
        .accessibility_label(`${p.label}${named ? ` (${sh.label})` : ""}: ${Math.round(left(w))}% left of ${w.label}`)
        .child(icon(p, 12))
        .when(named, (el) => el.child(div().max_w(64).flex_none().truncate().text_size(11).text_color(t.dim).child(sh.label)))
        .child(bar(p, w, 3))
        .child(div().w(30).flex_none().text_right().text_size(11).text_color(tone(left(w)) ?? t.muted).child(`${Math.round(left(w))}%`))
        .child(div().w(40).flex_none().text_right().text_size(11).text_color(t.dim).child(resetsIn(w, now)));
      return Popover.new(`${id}-pop`).anchor("top_left").open(this.openKey === p.key)
        .on_open_change((open, cx) => this.toggle(p.key, open, cx))
        .trigger(trigger).content(card(p));
    };

    const rows = this.rows();
    if (!rows.length) return div().id("limits");

    // The status bar: one icon and what's left per provider, up to the chosen count in the
    // saved order; a click opens every provider together.
    if (!sidebar) {
      const strip = rows.slice(0, this.maxItems);
      const seg = (p) => {
        const w = tightest(this.state[this.shown(p).key].windows, now), rem = Math.round(left(w));
        return h_flex().id(`limits-seg-${p.key}`).gap(6).items_center().flex_none()
          .accessibility_label(`${p.label}: ${rem}% left`)
          .child(icon(p, 13))
          .child(div().whitespace_nowrap().text_size(10.5).font_medium().text_color(tone(rem) ?? t.foreground).child(`${rem}%`));
      };
      const content = h_flex().id("limits-bar").gap(10).items_center().flex_none()
        .children(strip.flatMap((p, i) => [...(i > 0 ? [div().w(1).h(14).bg(t.border).flex_none()] : []), seg(p)]));
      return h_flex().id("limits").size_full().px(12).items_center().justify_end().overflow_hidden()
        .bg(t.chrome).border_t(1).border_color(t.border).text_size(11)
        .child(Popover.new("limits-pop").anchor("bottom_right").open(this.open)
          .on_open_change((open, cx) => this.toggleBar(open, cx))
          .trigger(content).content(unified(rows)));
    }

    // Folded: the tightest shown window of all, on the heading.
    const top = rows.map((p) => ({ p, w: tightest(this.state[this.shown(p).key].windows, now) }))
      .reduce((a, b) => (!a || usedNow(b.w, now) > usedNow(a.w, now) ? b : a), null);
    return v_flex().id("limits").size_full().bg(t.chrome).text_size(12)
      .child(h_flex().id("limits-head").h(HEAD).flex_none().pl(16).pr(12).gap(6).items_center()
        .role("button").accessibility_label(this.collapsed ? "Show usage limits" : "Fold usage limits")
        .on_click((_e, cx) => {
          this.collapsed = !this.collapsed;
          localStorage.setItem("collapsed", String(this.collapsed));
          this.fit();
          cx.notify();
        })
        .child(div().text_size(12).font_medium().text_color(t.muted).child("Usage"))
        .child(div().flex_1())
        .when(this.collapsed, (el) => el
          .child(icon(top.p, 11))
          .child(div().text_size(11).text_color(tone(left(top.w)) ?? t.muted).child(`${Math.round(left(top.w))}%`))
          .child(div().text_size(11).text_color(t.dim).child(resetsIn(top.w, now))))
        .child(svg(`mods/workspace-chrome/chevron-${this.collapsed ? "right" : "down"}.svg`).size(11).flex_none().text_color(t.dim)))
      .when(!this.collapsed, (el) => el.children(rows.map(row)));
  }
}
