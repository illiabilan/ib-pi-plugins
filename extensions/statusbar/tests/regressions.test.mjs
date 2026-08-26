/**
 * Regressions found by looking at the bar in a real session rather than through the
 * suite's own fixtures.
 *
 *   1. Pre-coloured extension statuses (the MCP adapter publishes one) printed their
 *      escape payload literally: "[38;2;90;128;128m🔌 MCP: 2 servers enabled [39m".
 *      sanitize() dropped the ESC byte but kept the rest of the sequence.
 *   2. The widest abbreviation tier still capped the branch at 24 columns, so a long
 *      branch was ellipsised on a 150-column terminal that had room to spare.
 */
import { EXT_FILE, mockTheme, visibleWidth } from "./helpers.mjs";

let pass = 0, fail = 0;
const ck = (n, c, x = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, x); } };

const factory = (await import(EXT_FILE)).default;
const mount = async (over = {}) => {
  let ff; const h = {};
  factory({ registerCommand(){}, registerShortcut(){}, registerTool(){}, on: (e, fn) => (h[e] = fn) });
  await h.session_start?.({}, {
    cwd: "/tmp", mode: "tui", hasUI: true,
    model: { id: "claude-opus-5", provider: "anthropic", contextWindow: 1000000 },
    thinkingLevel: "high",
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    getContextUsage: () => ({ tokens: 84000, contextWindow: 1000000, percent: 8.4 }),
    ui: { setFooter: (f) => (ff = f), notify(){}, getTheme: () => "dark", getAllThemes: () => ["dark"] },
    ...over,
  });
  return ff;
};
const plain = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");

// 1. ANSI-carrying statuses
{
  const ff = await mount();
  const f = ff({ requestRender(){} }, mockTheme, {
    getGitBranch: () => "main", onBranchChange: () => () => {},
    getExtensionStatuses: () => new Map([
      ["mcp", "\u001b[38;2;90;128;128m\u{1F50C} MCP: 2 servers enabled \u001b[39m"],
      ["osc", "\u001b]8;;http://example.com\u0007linked\u001b]8;;\u0007"],
    ]),
  });
  const line = plain(f.render(150)[0] ?? "");
  ck("no leftover CSI payload in the status line", !/\[[0-9;]+m/.test(line), JSON.stringify(line));
  ck("no leftover OSC hyperlink payload", !/\]8;;|example\.com/.test(line), JSON.stringify(line));
  ck("the status text itself survives", /MCP: 2 servers enabled/.test(line) && /linked/.test(line), JSON.stringify(line));
  ck("status line still respects the width", visibleWidth(f.render(40)[0] ?? "") <= 40);
  f.dispose?.();
}

// 2. Long branch on a wide terminal
{
  const branch = "ib/ada-48913-upsell-remaining-issubscriber"; // 41 cols
  const ff = await mount();
  const f = ff({ requestRender(){} }, mockTheme, {
    getGitBranch: () => branch, onBranchChange: () => () => {},
    getExtensionStatuses: () => new Map(),
  });
  await new Promise((r) => setTimeout(r, 300));
  const wide = plain(f.render(200).at(-1) ?? "");
  ck("wide terminal shows the branch in full", wide.includes(branch), wide);
  ck("no ellipsis when there is room", !wide.includes("…"), wide);
  const narrow = plain(f.render(90).at(-1) ?? "");
  ck("narrow terminal still abbreviates", narrow.includes("…"), narrow);
  ck("abbreviation keeps the tail", /issubscriber/.test(narrow), narrow);
  for (const w of [200, 150, 120, 90, 60, 30]) {
    const lines = f.render(w);
    if (lines.some((l) => visibleWidth(l) > w)) ck(`width bound at ${w}`, false, lines.map((l) => visibleWidth(l)).join(","));
  }
  ck("width bound holds across the range", true);
  f.dispose?.();
}

// 3. Placement: the bar belongs ABOVE the input, and must not be drawn twice.
{
  let ff, widget, cmd;
  const h = {};
  factory({
    registerCommand: (n, c) => { if (n === "statusbar") cmd = c; },
    registerShortcut(){}, registerTool(){}, on: (e, fn) => (h[e] = fn),
  });
  const ui = {
    setFooter: (f) => (ff = f),
    setWidget: (key, content) => { widget = content === undefined ? undefined : { key, content }; },
    notify(){}, select: async () => undefined,
    getTheme: () => "dark", getAllThemes: () => ["dark"],
  };
  const ctx = {
    cwd: "/tmp", mode: "tui", hasUI: true,
    model: { id: "claude-opus-5", provider: "anthropic", contextWindow: 1000000 },
    thinkingLevel: "high",
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 1000000, percent: 0.1 }),
    ui,
  };
  await h.session_start?.({}, ctx);
  ck("default placement registers a widget above the editor", !!widget && widget.key === "statusbar", JSON.stringify(widget?.key));
  const footerComp = ff?.({ requestRender(){} }, mockTheme, {
    getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map(),
  });
  ck("the footer renders NOTHING while the widget draws (no duplicate bar)", (footerComp?.render(120) ?? []).length === 0);
  const widgetComp = widget.content({ requestRender(){} }, mockTheme);
  const drawn = plain(widgetComp.render(120).at(-1) ?? "");
  ck("the widget draws the actual bar", /π/.test(drawn) && /think:high/.test(drawn), drawn);

  // switching to the footer flips which component draws
  await cmd.handler("footer", ctx);
  ck("/statusbar footer clears the widget", widget === undefined);
  const footer2 = ff({ requestRender(){} }, mockTheme, {
    getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map(),
  });
  ck("/statusbar footer makes the footer draw the bar", /π/.test(plain(footer2.render(120).at(-1) ?? "")));
  await cmd.handler("above", ctx);
  ck("/statusbar above puts the widget back", !!widget);

  // a UI without setWidget must still show the bar, in the footer
  let ff2;
  const h2 = {};
  factory({ registerCommand(){}, registerShortcut(){}, registerTool(){}, on: (e, fn) => (h2[e] = fn) });
  await h2.session_start?.({}, { ...ctx, ui: { ...ui, setWidget: undefined, setFooter: (f) => (ff2 = f) } });
  const fallback = ff2?.({ requestRender(){} }, mockTheme, {
    getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map(),
  });
  ck("falls back to the footer when the host has no setWidget", /π/.test(plain(fallback?.render(120).at(-1) ?? "")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
