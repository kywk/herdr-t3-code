// node check-limits.cjs: the mod's parsers, picks and rows against small fixtures and a fake machine.
// No real program runs and nothing reaches the network; every key below is a made-up string.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function element() {
  const node = { key: null, items: [], handlers: {}, style: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === "when") { if (args[0]) args[1](proxy); }
      else if (["child", "content", "trigger"].includes(key)) node.items.push(args[0]);
      else if (key === "children") node.items.push(...args[0]);
      else if (key === "id") node.key = args[0];
      else if (key.startsWith("on_")) node.handlers[key] = args[0];
      else node.style[key] = args;
      return proxy;
    };
  } });
  return proxy;
}
const find = (node, id) => {
  if (!node || typeof node !== "object") return null;
  if (node.key === id) return node;
  for (const c of node.items) { const hit = find(c, id); if (hit) return hit; }
  return null;
};
const texts = (node) => (typeof node === "string" ? [node] : node && typeof node === "object" ? node.items.flatMap(texts) : []);
const ids = (node, out = []) => {
  if (!node || typeof node !== "object") return out;
  if (node.key) out.push(node.key);
  for (const c of node.items) ids(c, out);
  return out;
};

const NOW = Date.parse("2026-11-03T12:00:00Z");
const HOME = "/Users/me";
const APP = `${HOME}/.config/herdr-app`;

// A fake machine: `files` by path, `programs` answer exec by the script they're given, `web` answers fetch.
function machine({ found = [], files = {}, programs = {}, web = () => ({ status: 404 }), node = "limits", accounts = null, launcher = true } = {}) {
  const m = { now: NOW, store: new Map(), runs: [], fetches: [], execs: [], jobs: [], shared: { "limits.accounts": accounts }, overlays: [], input: "", waiters: [] };
  const env = {
    View: class {}, div: element, svg: element, image: element, v_flex: element, h_flex: element,
    Popover: { new: (id) => element().id(id) }, Input: { new: element },
    InputState: { new: () => ({ on() {}, value: () => m.input, set_value(v) { m.input = v; }, focus() {} }) },
    appHome: () => APP, focused: () => ({ space: "s1" }),
    shared: (k) => m.shared[k] ?? null, setShared: (k, v) => { m.shared[k] = JSON.parse(JSON.stringify(v)); },
    openOverlay: (o) => { m.overlays.push(o); return "o1"; }, notify: (n) => { m.notice = n; },
    // watchFolder waits until the test hands it a batch of changed paths with m.change().
    watchFolder: () => new Promise((r) => m.waiters.push(r)), nextCommand: () => new Promise(() => {}),
    Date: class extends Date { static now() { return m.now; } },
    localStorage: { getItem: (k) => m.store.get(k) ?? null, setItem: (k, v) => m.store.set(k, String(v)) },
    theme: () => ({ foreground: "#fff", muted: "#aaa", dim: "#888", border: "#333", hover: "#222", chrome: "#111", popover: "#000", blocked: "#f0a33a", ansi3: "#f2c14e" }),
    props: () => (node ? { node } : {}),
    home: () => HOME,
    run: (...a) => m.runs.push(a),
    readTextFile: async (p) => files[p] ?? (p === `${APP}/mods/t3-new-menu/accounts.js` && launcher ? "export {}" : null),
    exec: async (cmd, args) => {
      m.execs.push([cmd, ...args]);
      const script = [cmd, ...args].join(" ");
      if (script.includes("command -v \"$p\"")) return { code: 0, stdout: found.join("\n"), stderr: "" };
      for (const [needle, answer] of Object.entries(programs)) {
        if (script.includes(needle)) {
          if (answer instanceof Error) throw answer;
          return { code: 0, stderr: "", ...answer };
        }
      }
      return { code: 1, stdout: "", stderr: "" };
    },
    fetch: async (url, opts = {}) => {
      m.fetches.push({ url, opts });
      const r = web(url, opts);
      return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body, text: async () => JSON.stringify(r.body) };
    },
  };
  // accounts.js, shared with t3-new-menu, is inlined as an import would bring it.
  const src = ["accounts.js", "main.js"].map((f) => fs.readFileSync(path.join(__dirname, f), "utf8")).join("\n")
    .replace(/^import [\s\S]*?;\r?\n/gm, "").replace(/^export (const|function) /gm, "$1 ").replace("export default class", "globalThis.Mod = class");
  const ctx = vm.createContext(env);
  vm.runInContext(src, ctx, { filename: "t3-limits/main.js" });
  const cx = {
    notify() { m.notified = true; }, stop_propagation() {},
    spawn: (fn) => m.jobs.push(fn(cx)),
    timer: { every: () => ({}), after: () => ({}) },
  };
  m.ctx = ctx;
  m.cx = cx;
  m.start = async () => {
    m.mod = new ctx.Mod();
    m.mod.init({}, cx);
    await m.settle();
  };
  // Every fake answers at once, so a few turns of the event loop finish all work; the command loop never ends.
  m.settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  m.render = () => (m.tree = m.mod.render(cx));
  m.change = async (paths) => { m.waiters.shift()?.(paths); await m.settle(); };
  m.rows = () => plain(ids(m.render())).filter((k) => /^limits-[a-z]+$/.test(k) && k !== "limits-head").map((k) => k.slice(7));
  m.click = (id) => { const n = find(m.tree, id); assert.ok(n, `missing ${id}`); n.handlers.on_click({}, cx); };
  m.openChange = (provider, open) => find(m.tree, `limits-${provider}-pop`).handlers.on_open_change(open, cx);
  m.isOpen = (provider) => find(m.render(), `limits-${provider}-pop`).style.open[0];
  return m;
}
// Values made inside the vm are compared as plain data (its arrays have their own prototype).
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const fns = new Proxy(machine().ctx, { get: (ctx, k) => (typeof ctx[k] === "function" ? (...a) => plain(ctx[k](...a)) : ctx[k]) });

// get_usage's reply as the Claude CLI sends it: percents 0-100, ISO resets.
const CLAUDE_USAGE = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 12, resets_at: "2026-11-03T15:00:00Z" },
    seven_day: { utilization: 71, resets_at: "2026-11-05T06:59:59.6+00:00" },
    seven_day_opus: null,
    model_scoped: [{ display_name: "Fable", utilization: 3, resets_at: "2026-11-05T06:59:59Z" }, { display_name: 7 }],
    spend: { enabled: true, used: { amount_minor: 2500, currency: "USD", exponent: 2 }, limit: { amount_minor: 10000, currency: "USD", exponent: 2 } },
  },
};
const claudeStdout = (usage) => [
  JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "init", response: { account: { email: "someone@example.com" } } } }),
  JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "usage", response: usage } }),
].join("\n");

// account/rateLimits/read's result, as codex app-server answers.
const CODEX_RESULT = {
  rateLimits: { limitId: "codex", planType: "plus", primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1793700000 }, secondary: { usedPercent: 92, windowDurationMins: 10080, resetsAt: 1794000000 } },
  rateLimitsByLimitId: { codex: { limitId: "codex", planType: "prolite", primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1793844431 }, secondary: null } },
};
const ROLLOUT_LINE = JSON.stringify({ timestamp: "2026-10-30T11:52:49.302Z", type: "event_msg", payload: { type: "token_count", rate_limits: {
  limit_id: "codex", plan_type: "plus", primary: { used_percent: 55.5, window_minutes: 300, resets_at: 1793760000 }, secondary: { used_percent: 20, window_minutes: 10080, resets_at: 1794000000 } } } });

test("Claude: 5h, weekly, a model's weekly and monthly spend, as T3 labels them", () => {
  const ws = fns.claudeWindows(CLAUDE_USAGE);
  assert.deepEqual(ws.map((w) => [w.id, w.label, w.used]), [
    ["five_hour", "5h", 12], ["seven_day", "Weekly", 71], ["seven_day_fable", "Weekly · Fable", 3], ["monthly_spend", "Monthly spend", 25]]);
  assert.equal(ws[1].resetsAt, Date.parse("2026-11-05T06:59:59.6Z"));
  assert.equal(ws[3].resetsAt, null);
  assert.equal(fns.claudeWindows({ rate_limits_available: false }), null, "an API key has no subscription windows");
  // Spend in two currencies falls back to extra usage.
  const mixed = { ...CLAUDE_USAGE.rate_limits, five_hour: null, seven_day: null, model_scoped: [],
    spend: { enabled: true, used: { amount_minor: 1, currency: "USD", exponent: 2 }, limit: { amount_minor: 2, currency: "EUR", exponent: 2 } },
    extra_usage: { is_enabled: true, used_credits: 30, monthly_limit: 40 } };
  assert.deepEqual(fns.claudeWindows({ rate_limits_available: true, rate_limits: mixed }).map((w) => w.used), [75]);
});

test("Claude: only the get_usage answer is read from the stream; an error reply throws", () => {
  assert.equal(fns.claudeReply(claudeStdout(CLAUDE_USAGE)).length, 4);
  const err = JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: "usage", error: "get_usage is not supported" } });
  assert.throws(() => fns.claudeReply(err), /not supported/);
  assert.throws(() => fns.claudeReply(""), /did not answer/);
});

test("Codex: the main allowance by its id, window lengths, plans and model limits", () => {
  assert.deepEqual(fns.codexReply(CODEX_RESULT).map((w) => [w.id, w.label, w.used, w.resetsAt]), [["primary", "Weekly", 1, 1793844431000]]);
  assert.deepEqual(fns.codexReply({ rateLimits: CODEX_RESULT.rateLimits }).map((w) => w.label), ["5h", "Weekly"]);
  // No window length: paid plans mean 5h and weekly, Free and Go a month.
  assert.deepEqual(fns.codexWindows({ planType: "plus", primary: { usedPercent: 3 }, secondary: { usedPercent: 4 } }).map((w) => w.label), ["5h", "Weekly"]);
  assert.deepEqual(fns.codexWindows({ planType: "free", primary: { usedPercent: 3 } }).map((w) => w.label), ["Monthly"]);
  assert.deepEqual(fns.codexWindows({ limitId: "gpt-5-codex-max", primary: { usedPercent: 99 } }), [], "a model's own limit isn't the allowance");
  assert.deepEqual(fns.codexWindows({ individualLimit: { remainingPercent: 30, resetsAt: 1794000000 } }).map((w) => [w.label, w.used]), [["Monthly credit limit", 70]]);
});

test("Codex: a rollout's token_count line reads as the same windows", () => {
  assert.deepEqual(fns.codexRollout(ROLLOUT_LINE).map((w) => [w.label, w.used, w.mins]), [["5h", 55.5, 300], ["Weekly", 20, 10080]]);
  assert.equal(fns.codexRollout(JSON.stringify({ type: "response_item", payload: { type: "message" } })), null);
});

test("OpenCode Go: rolling, weekly and monthly", () => {
  const body = { usage: { rolling: { percent: 10, resetsAt: "2026-11-03T14:00:00Z" }, weekly: { percent: 50, resetsAt: "2026-11-08T00:00:00Z" }, monthly: { percent: 80, resetsAt: "2026-12-01T00:00:00Z" } } };
  assert.deepEqual(fns.opencodeWindows(body).map((w) => [w.label, w.used]), [["5h", 10], ["Weekly", 50], ["Monthly", 80]]);
  assert.throws(() => fns.opencodeWindows({}));
});

test("Antigravity: summary buckets by family, untouched resets dropped; models as the fallback", () => {
  const summary = { groups: [{ displayName: "Pro", buckets: [
    { bucketId: "gemini-pro-5h", window: "5h", remainingFraction: 0.25, resetTime: "2026-11-03T14:00:00Z" },
    { bucketId: "3p-weekly", window: "weekly", remainingFraction: 1, resetTime: new Date(NOW + 7 * 86400000).toISOString() },
    { bucketId: "gemini-off", window: "5h", remainingFraction: 0, disabled: true },
  ] }] };
  const ws = fns.antigravitySummary(summary, NOW);
  assert.deepEqual(ws.map((w) => [w.label, w.used, w.resetsAt !== null]), [["Gemini · 5h", 75, true], ["Claude & GPT (shared) · Weekly", 0, false]]);
  const models = { models: {
    "gemini-3-pro": { quotaInfo: { remainingFraction: 0.5 } }, "gemini-3-flash": { quotaInfo: { remainingFraction: 0.9 } },
    "claude-sonnet": { modelProvider: "MODEL_PROVIDER_ANTHROPIC", weeklyQuotaInfo: { remainingFraction: 0.1, resetTime: "2026-11-09T00:00:00Z" } },
    "mystery": { quotaInfo: { remainingFraction: 0 } } } };
  assert.deepEqual(fns.antigravityModels(models).map((w) => [w.label, Math.round(w.used)]), [["Gemini · Reported quota", 50], ["Claude · Weekly", 90]]);
  assert.deepEqual(fns.mostUsed([[{ id: "a", used: 10 }], [{ id: "a", used: 30 }]]).map((w) => w.used), [30]);
});

const AG_SUMMARY = { groups: [{ displayName: "Pro", buckets: [
  { bucketId: "gemini-pro-weekly", window: "weekly", remainingFraction: 0.6, resetTime: "2026-11-07T00:00:00Z" },
] }] };

test("Antigravity CLI: Keychain login is read when there is no ACP file", async () => {
  const ACCESS = "ya29.cli-fake";
  const m = machine({
    found: ["antigravity"],
    programs: { "find-generic-password": { stdout: `${ACCESS}\n` } },
    web: (url) => url.endsWith(":retrieveUserQuotaSummary") ? { status: 200, body: AG_SUMMARY } : { status: 404 },
  });
  await m.start();
  assert.deepEqual(m.rows(), ["antigravity"]);
  assert.ok(texts(find(m.tree, "limits-antigravity")).includes("40%"));
  for (const f of m.fetches) {
    const host = new URL(f.url).host;
    assert.ok(["cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com"].includes(host), `CLI token went to ${host}`);
  }
  const kept = JSON.stringify([...m.store.entries()]) + JSON.stringify(m.mod.state) + texts(m.render()).join("");
  assert.ok(!kept.includes(ACCESS), "CLI access token leaked into storage or rows");
});

test("Antigravity CLI: an expired Keychain token refreshes through agy once", async () => {
  let n = 0;
  const m = machine({
    found: ["antigravity"],
    programs: { "find-generic-password": { stdout: "ya29.cli-old\n" }, "agy models": { stdout: "" } },
    web: (url) => {
      if (!url.endsWith(":retrieveUserQuotaSummary")) return { status: 404 };
      n += 1;
      return n <= 2 ? { status: 401 } : { status: 200, body: AG_SUMMARY };
    },
  });
  await m.start();
  assert.deepEqual(m.rows(), ["antigravity"]);
  assert.ok(m.execs.some((e) => e[0] === "agy" && e[1] === "models"), "agy refreshes its own login");
  assert.equal(m.execs.filter((e) => e.join(" ").includes("find-generic-password")).length, 2, "Keychain re-read after refresh");
});

test("Antigravity CLI: no Keychain login means no row", async () => {
  const m = machine({ found: ["antigravity"] });
  await m.start();
  assert.deepEqual(m.rows(), []);
});

test("Grok Build: one subscription window for its period; a missing percent with a full period is 0", () => {
  const period = { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-11-01T00:00:00Z", end: "2026-11-08T00:00:00Z" };
  assert.deepEqual(fns.grokWindows({ config: { creditUsagePercent: 64, currentPeriod: period } }).map((w) => [w.label, w.used, w.resetsAt]),
    [["Weekly", 64, Date.parse("2026-11-08T00:00:00Z")]]);
  assert.deepEqual(fns.grokWindows({ config: { currentPeriod: period } }).map((w) => w.used), [0]);
  assert.deepEqual(fns.grokWindows({ config: { creditUsagePercent: 10, currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" } } }).map((w) => w.label), ["Monthly"]);
  assert.deepEqual(fns.grokWindows({ config: {} }), []);
});

test("Cursor: Overall, Cursor Models and Other Models for the billing cycle", () => {
  const body = { billingCycleEnd: "1795000000000", planUsage: { totalPercentUsed: 42, autoPercentUsed: 12.5, apiPercentUsed: 80 } };
  assert.deepEqual(fns.cursorWindows(body).map((w) => [w.label, w.used, w.resetsAt]),
    [["Overall", 42, 1795000000000], ["Cursor Models", 12.5, 1795000000000], ["Other Models", 80, 1795000000000]]);
  assert.deepEqual(fns.cursorWindows({ planUsage: { totalPercentUsed: 5 } }).map((w) => w.resetsAt), [null]);
  assert.deepEqual(fns.cursorWindows({}), []);
});

test("the tightest window is the most used, and a window past its reset counts as empty", () => {
  const ws = [fns.win("a", "5h", 95, NOW - 1000, 300), fns.win("b", "Weekly", 60, NOW + 86400000, 10080), fns.win("c", "Monthly", 20, NaN)];
  assert.equal(fns.tightest(ws, NOW).id, "b");
  assert.equal(fns.tightest(ws, NOW - 2000).id, "a");
  assert.equal(fns.tightest([], NOW), null);
  assert.equal(fns.win("x", "x", 140, NaN).used, 100);
});

test("reset times: T3's 2d 4h / 4h 12m / 12m, now, and the exact time", () => {
  assert.equal(fns.duration(2 * 86400000 + 4 * 3600000 + 5 * 60000), "2d 4h");
  assert.equal(fns.duration(4 * 3600000 + 12 * 60000 + 30000), "4h 12m");
  assert.equal(fns.duration(12 * 60000), "12m");
  assert.equal(fns.resetsIn(fns.win("a", "a", 1, NOW - 1), NOW), "now");
  assert.equal(fns.resetsIn(fns.win("a", "a", 1, NaN), NOW), "");
  const at = new Date(2026, 10, 5, 7, 59).getTime();
  assert.equal(fns.exactTime(at), "Thu Nov 5, 07:59");
});

test("rows: real numbers for Claude and Codex; a provider with no window has no row", async () => {
  const m = machine({
    found: ["claude", "codex", "opencode"],
    programs: { "get_usage": { stdout: claudeStdout(CLAUDE_USAGE) }, "account/rateLimits/read": { stdout: JSON.stringify({ id: 2, result: CODEX_RESULT }) } },
    files: { [`${HOME}/.local/share/opencode/auth.json`]: JSON.stringify({ openrouter: { type: "api", key: "sk-or-fake" } }) },
  });
  await m.start();
  assert.deepEqual(m.rows(), ["codex", "claude"], "T3's order; OpenCode without a Go key has no row");
  const claude = texts(find(m.tree, "limits-claude"));
  assert.ok(claude.includes("71%") && claude.includes("1d 18h"), claude.join("|"));
  assert.ok(texts(find(m.tree, "limits-codex")).includes("1%"));
  assert.equal(m.fetches.length, 0, "OpenRouter's key is not OpenCode Go's: nothing is sent");
  // The card lists every window with its exact reset.
  const card = texts(find(m.tree, "limits-card-claude")).join("|");
  assert.match(card, /Weekly · Fable/);
  assert.match(card, /Resets in 3h 0m · /);
  // Hidden while nothing had a window, then shown at heading + 2 rows + foot.
  assert.deepEqual(plain(m.runs), [["layout.hide", { id: "limits" }], ["layout.show", { id: "limits" }], ["layout.resize", { id: "limits", px: 26 + 2 * 20 + 6 }]]);
  assert.ok(!texts(m.tree).includes("no data"));
});

test("with no windows anywhere the strip draws nothing and its block is hidden", async () => {
  const m = machine({ found: ["claude", "codex", "opencode"], programs: { "get_usage": { stdout: claudeStdout({ rate_limits_available: false }) } } });
  await m.start();
  assert.deepEqual(m.rows(), []);
  assert.deepEqual(m.tree.items, [], "an empty element, not a heading");
  assert.deepEqual(plain(m.runs), [["layout.hide", { id: "limits" }]]);
  const bar = machine({ found: ["claude"], node: null });
  await bar.start();
  assert.deepEqual(bar.render().items, []);
  assert.equal(bar.runs.length, 0);
});

test("folding keeps one summary line and is remembered", async () => {
  const m = machine({ found: ["claude"], programs: { "get_usage": { stdout: claudeStdout(CLAUDE_USAGE) } } });
  await m.start();
  m.render();
  find(m.tree, "limits-head").handlers.on_click({}, m.cx);
  assert.equal(m.store.get("collapsed"), "true");
  assert.deepEqual(m.rows(), []);
  assert.ok(texts(find(m.tree, "limits-head")).includes("71%"));
  assert.deepEqual(plain(m.runs.at(-1)), ["layout.resize", { id: "limits", px: 28 }]);
  const again = machine({ found: ["claude"] });
  again.store.set("collapsed", "true");
  await again.start();
  assert.equal(again.mod.collapsed, true);
});

test("a failed read keeps the last good windows, backs off, and a top bar doesn't resize", async () => {
  const m = machine({ found: ["codex"], node: null, programs: { "account/rateLimits/read": { stdout: JSON.stringify({ id: 2, result: CODEX_RESULT }) } } });
  await m.start();
  const cached = JSON.parse(m.store.get("cache"));
  assert.equal(cached.codex.windows[0].used, 1);
  m.mod.state.codex.nextAt = 0;
  m.ctx.exec = async () => { throw new Error("boom"); };
  m.mod.refresh(m.cx);
  await m.settle();
  const s = m.mod.state.codex;
  assert.equal(s.windows[0].used, 1);
  assert.equal(s.failures, 1);
  assert.equal(s.nextAt, NOW + 10 * 60000);
  assert.ok(texts(m.render()).includes("1%"));
  assert.equal(m.runs.length, 0);
});

test("Codex falls back to the newest rollout when the app-server doesn't answer", async () => {
  const m = machine({ found: ["codex"], programs: { "account/rateLimits/read": { stdout: "" }, "rollout-": { stdout: ROLLOUT_LINE + "\n" } } });
  await m.start();
  assert.deepEqual(plain(m.mod.state.codex.windows).map((w) => w.used), [55.5, 20]);
});

test("credentials go only to their own host and never into storage or the rows", async () => {
  const GO = "sk-go-fake-0001", REFRESH = "1//fake-refresh", SECRET = "fake-secret", ACCESS = "ya29.fake-access", GROK = "xai-fake-0002", CURSOR = "cursor-fake-0003";
  const m = machine({
    found: ["opencode", "antigravity", "grok", "cursor"],
    programs: { "sqlite3": new Error("no db") },
    files: {
      [`${HOME}/.local/share/opencode/auth.json`]: JSON.stringify({ "opencode-go": { type: "api", key: GO } }),
      [`${HOME}/.gemini/antigravity-acp/acp_token.json`]: JSON.stringify({ client_id: "cid", client_secret: SECRET, refresh_token: REFRESH, project_id: "p1" }),
      [`${HOME}/.grok/auth.json`]: JSON.stringify({ "https://accounts.x.ai/sign-in": { key: GROK, email: "a@example.com" }, "https://other.example/x": { key: "xai-other-fake" } }),
      [`${HOME}/.cursor/auth.json`]: JSON.stringify({ accessToken: CURSOR }),
    },
    web: (url) => url.startsWith("https://opencode.ai/") ? { status: 200, body: { usage: { rolling: { percent: 5, resetsAt: "2026-11-03T13:00:00Z" }, weekly: { percent: 6, resetsAt: "2026-11-08T00:00:00Z" }, monthly: { percent: 7, resetsAt: "2026-12-01T00:00:00Z" } } } }
      : url === "https://oauth2.googleapis.com/token" ? { status: 200, body: { access_token: ACCESS, expires_in: 3600 } }
      : url.startsWith("https://cli-chat-proxy.grok.com/") ? { status: 200, body: { config: { creditUsagePercent: 33, currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "2026-12-01T00:00:00Z" } } } }
      : url.startsWith("https://api2.cursor.sh/") ? { status: 200, body: { billingCycleEnd: 1795000000000, planUsage: { totalPercentUsed: 50 } } }
      : url.endsWith(":retrieveUserQuotaSummary") ? { status: 200, body: { buckets: [{ bucketId: "gemini-pro", window: "weekly", remainingFraction: 0.6, resetTime: "2026-11-07T00:00:00Z" }] } }
      : { status: 404 },
  });
  await m.start();
  assert.deepEqual(m.rows(), ["grok", "cursor", "opencode", "antigravity"]);
  assert.ok(texts(find(m.tree, "limits-antigravity")).includes("40%"));
  for (const f of m.fetches) {
    const sent = JSON.stringify(f.opts);
    const host = new URL(f.url).host;
    if (sent.includes(GO)) assert.equal(host, "opencode.ai");
    if (sent.includes(REFRESH) || sent.includes(SECRET)) assert.equal(host, "oauth2.googleapis.com");
    if (sent.includes(GROK)) assert.equal(host, "cli-chat-proxy.grok.com");
    if (sent.includes(CURSOR)) assert.equal(host, "api2.cursor.sh");
    assert.ok(!sent.includes("xai-other-fake"), "another deployment's key is never sent");
    if (sent.includes(ACCESS)) assert.ok(["cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com"].includes(host), host);
  }
  assert.deepEqual(new Set(m.fetches.map((f) => new URL(f.url).host)), new Set(["cli-chat-proxy.grok.com", "api2.cursor.sh", "opencode.ai", "oauth2.googleapis.com", "cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com"]));
  const kept = JSON.stringify([...m.store.entries()]) + JSON.stringify(m.mod.state) + texts(m.render()).join("");
  for (const secret of [GO, REFRESH, SECRET, ACCESS, GROK, CURSOR]) assert.ok(!kept.includes(secret), `${secret} leaked`);
});

test("a Grok config that picks another account or endpoint, or an API-key login, sends nothing", async () => {
  const auth = (mode) => JSON.stringify({ "https://accounts.x.ai/sign-in": { key: "xai-fake", auth_mode: mode } });
  const custom = machine({ found: ["grok"], files: { [`${HOME}/.grok/auth.json`]: auth(), [`${HOME}/.grok/config.toml`]: '[endpoints]\nbase = "https://example.com"\n' } });
  await custom.start();
  const apiKey = machine({ found: ["grok"], files: { [`${HOME}/.grok/auth.json`]: auth("api_key") } });
  await apiKey.start();
  assert.equal(custom.fetches.length + apiKey.fetches.length, 0);
  assert.deepEqual(custom.rows(), []);
});

test("an OpenCode Console key for a self-hosted server is never sent to opencode.ai", async () => {
  const rows = [{ id: "opencode", value: JSON.stringify({ type: "key", key: "sk-self-fake", metadata: { server: "https://example.com/console" } }) }];
  const m = machine({ found: ["opencode"], programs: { "sqlite3": { stdout: JSON.stringify(rows) } } });
  await m.start();
  assert.equal(m.fetches.length, 0);
  assert.equal(m.mod.state.opencode.windows, null);
});

const BOTH = { "get_usage": { stdout: claudeStdout(CLAUDE_USAGE) }, "account/rateLimits/read": { stdout: JSON.stringify({ id: 2, result: CODEX_RESULT }) } };

test("a second click on the open row closes its card; another row switches; Esc closes", async () => {
  const m = machine({ found: ["claude", "codex"], programs: BOTH });
  await m.start();
  m.render();
  m.openChange("claude", true);
  assert.equal(m.isOpen("claude"), true);
  // The same press: the card's outside close lands first, then the trigger asks to open again.
  m.openChange("claude", false);
  m.openChange("claude", true);
  assert.equal(m.isOpen("claude"), false);
  // A press later opens it again; the trigger's own toggle closes it.
  m.now += 1000;
  m.openChange("claude", true);
  assert.equal(m.isOpen("claude"), true);
  m.openChange("claude", false);
  assert.equal(m.isOpen("claude"), false);
  // Another row while one is open, in either order of reports.
  m.now += 1000;
  m.openChange("claude", true);
  m.openChange("codex", true);
  m.openChange("claude", false);
  assert.deepEqual([m.isOpen("claude"), m.isOpen("codex")], [false, true]);
  m.openChange("codex", false); // Esc or a press outside
  assert.equal(m.isOpen("codex"), false);
});

test("adding an account makes its home, stores only id, label and path, and runs the login there", async () => {
  const m = machine({ found: ["claude"], programs: { ...BOTH, 'mkdir -p "$1"': { stdout: "" } } });
  await m.start();
  const home = `${APP}/data/t3-limits/accounts/claude/work`;
  m.input = "Work";
  m.mod.addAccount("claude", m.cx);
  await m.settle();
  await m.change([`${home}/.claude.json`]);
  assert.deepEqual(m.shared["limits.accounts"], { claude: { active: null, accounts: [{ id: "work", label: "Work", home }] } });
  assert.ok(m.execs.some((e) => e[0] === "sh" && e[2] === 'mkdir -p "$1"' && e[4] === home), "the path goes in as $1");
  assert.deepEqual(plain(m.runs.find((r) => r[0] === "tab.new")), ["tab.new", { space: "s1", name: "Work login", argv: ["env", `CLAUDE_CONFIG_DIR=${home}`, "claude", "auth", "login"] }]);
  // Read with its own home once the login wrote there.
  assert.ok(m.execs.some((e) => e.join(" ").includes("get_usage") && e.at(-1) === home));
  assert.equal(m.mod.state["claude:work"].windows.length, 4);
  // A second "Work" gets its own id.
  m.input = "Work";
  m.mod.addAccount("claude", m.cx);
  await m.settle();
  assert.deepEqual(m.shared["limits.accounts"].claude.accounts.map((a) => a.id), ["work", "work-2"]);
});

test("Use for new agents: the active account wraps new agents' argv; Default passes no variable", async () => {
  const home = `${APP}/data/t3-limits/accounts/codex/work`;
  const m = machine({ found: ["codex"], programs: BOTH, accounts: { codex: { active: null, accounts: [{ id: "work", label: "Work", home }] } } });
  await m.start();
  assert.ok(m.execs.some((e) => e[2]?.includes("ln -s") && e.at(-1) === home), "T3's auth overlay before reading");
  assert.ok(!m.execs.some((e) => e.join(" ").includes("rollout-")), "shared rollouts aren't one account's");
  m.render();
  m.openChange("codex", true);
  m.render();
  m.click("limits-use-codex:work");
  assert.equal(m.shared["limits.accounts"].codex.active, "work");
  assert.ok(texts(find(m.render(), "limits-codex")).includes("Work"), "the row names the active account");
  const store = m.shared["limits.accounts"], argv = ["codex", "--yolo"];
  assert.deepEqual(plain(m.ctx.accountArgv("codex", m.ctx.activeAccount(store, "codex"), argv)), ["env", `CODEX_HOME=${home}`, "codex", "--yolo"]);
  m.render();
  m.click("limits-use-codex");
  assert.equal(m.shared["limits.accounts"].codex.active, null);
  assert.deepEqual(plain(m.ctx.accountArgv("codex", m.ctx.activeAccount(m.shared["limits.accounts"], "codex"), argv)), argv);
  assert.equal(m.ctx.activeAccount({ claude: { active: "gone", accounts: [] } }, "claude"), null);
});

test("removing asks first, deletes only that account's folder and falls back to Default", async () => {
  const home = `${APP}/data/t3-limits/accounts/claude/work`;
  const m = machine({ found: ["claude"], programs: BOTH, accounts: { claude: { active: "work", accounts: [{ id: "work", label: "Work", home }] } } });
  await m.start();
  m.render();
  m.openChange("claude", true);
  m.render();
  m.click("limits-remove-claude:work");
  assert.equal(m.overlays[0].mod, "confirm");
  const name = m.overlays[0].props.command.name;
  assert.match(name, /^t3-limits\.remove-[0-9a-f]{16}$/);
  assert.ok(!m.execs.some((e) => e[0] === "rm"), "nothing deleted before the confirm");
  await m.mod.command(name.slice("t3-limits.".length));
  assert.deepEqual(m.execs.filter((e) => e[0] === "rm"), [["rm", "-rf", "--", home]]);
  assert.deepEqual(m.shared["limits.accounts"].claude, { active: null, accounts: [] });
  assert.equal(m.mod.state["claude:work"], undefined);
});

test("a cancelled, stale or bare remove command deletes nothing", async () => {
  const home = `${APP}/data/t3-limits/accounts/claude/work`;
  const m = machine({ found: ["claude"], programs: BOTH, accounts: { claude: { active: null, accounts: [{ id: "work", label: "Work", home }] } } });
  await m.start();
  const ask = () => { m.mod.askRemove("claude", m.mod.accounts("claude")[0]); return m.overlays.at(-1).props.command.name.slice("t3-limits.".length); };
  // Cancel: the confirm closes and nothing runs; a bare command later does nothing and disarms it.
  let c = ask();
  await m.mod.command("remove");
  await m.mod.command(c);
  // Cancel, then back to a card: the armed remove is gone.
  c = ask();
  m.render();
  m.openChange("claude", true);
  await m.mod.command(c);
  // A confirm older than a minute.
  c = ask();
  m.now += 61000;
  await m.mod.command(c);
  // Another confirm's nonce.
  ask();
  await m.mod.command("remove-0123456789abcdef");
  assert.equal(m.execs.filter((e) => e[0] === "rm").length, 0);
  assert.equal(m.shared["limits.accounts"].claude.accounts.length, 1);
});

test("an account entry that isn't this mod's own folder is ignored", async () => {
  const bad = [
    { id: "evil", label: "Evil", home: `${HOME}/.claude` },
    { id: "../x", label: "Up", home: `${APP}/data/t3-limits/accounts/claude/../x` },
    { id: "other", label: "Other", home: `${APP}/data/t3-limits/accounts/codex/other` },
  ];
  const m = machine({ found: ["claude"], programs: BOTH, accounts: { claude: { active: "evil", accounts: bad } } });
  await m.start();
  assert.deepEqual(plain(m.mod.accounts("claude")), []);
  assert.ok(!m.execs.some((e) => bad.some((a) => e.includes(a.home))), "never read, linked or deleted");
  const store = m.shared["limits.accounts"];
  assert.equal(m.ctx.activeAccount(store, "claude"), null);
  for (const a of bad) assert.deepEqual(plain(m.ctx.accountArgv("claude", a, ["claude"])), ["claude"]);
  m.render();
  m.openChange("claude", true);
  assert.equal(find(m.render(), "limits-account-claude:evil"), null);
});

test("while a login runs, only its login file triggers a read, at most one per 15s", async () => {
  const home = `${APP}/data/t3-limits/accounts/claude/work`, login = `${home}/.claude.json`;
  const none = { "get_usage": { stdout: claudeStdout({ rate_limits_available: false }) }, 'mkdir -p "$1"': { stdout: "" } };
  const m = machine({ found: ["claude"], programs: none });
  await m.start();
  const reads = () => m.execs.filter((e) => e.join(" ").includes("get_usage") && e.at(-1) === home).length;
  m.input = "Work";
  m.mod.addAccount("claude", m.cx);
  await m.settle();
  await m.change([`${home}/backups/x.json`, `${home}/policy-limits.json`]);
  assert.equal(reads(), 0, "the probe's own files don't count");
  await m.change([login]);
  await m.change([login]);
  await m.change([login]);
  assert.equal(reads(), 1, "repeated changes inside 15s give one read");
  m.now += 16000;
  await m.change([login]);
  assert.equal(reads(), 2);
});

test("without t3-new-menu there's no account to choose for new agents", async () => {
  const home = `${APP}/data/t3-limits/accounts/claude/work`;
  const m = machine({ found: ["claude"], programs: BOTH, launcher: false, accounts: { claude: { active: "work", accounts: [{ id: "work", label: "Work", home }] } } });
  await m.start();
  m.render();
  m.openChange("claude", true);
  const tree = m.render();
  assert.equal(find(tree, "limits-use-claude"), null);
  assert.ok(find(tree, "limits-remove-claude:work"), "accounts are still listed with their limits");
  assert.ok(!texts(find(tree, "limits-claude")).includes("Work"));
});

test("t3-new-menu carries the same accounts.js", { skip: !fs.existsSync(path.join(__dirname, "../t3-new-menu/accounts.js")) }, () => {
  assert.equal(fs.readFileSync(path.join(__dirname, "../t3-new-menu/accounts.js"), "utf8"), fs.readFileSync(path.join(__dirname, "accounts.js"), "utf8"));
});
