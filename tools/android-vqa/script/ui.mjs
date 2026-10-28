/** uiautomator XML parsing, node matching and assertion evaluation. Pure functions. */

export const fix = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const decode = (s) =>
  s.replace(/&#10;/g, "\n").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** @returns {{text:string, desc:string, id:string, bounds:number[], clickable:boolean, checked:boolean, visible:boolean}[]} */
export function parseNodes(xml) {
  const out = [];
  const attr = (n, name) => {
    const m = n.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
    return m ? decode(m[1]) : "";
  };
  for (const m of xml.matchAll(/<node\s[^>]*>/g)) {
    const n = m[0];
    const b = attr(n, "bounds").match(/-?\d+/g)?.map(Number) ?? [0, 0, 0, 0];
    const bounds = [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0];
    out.push({
      text: attr(n, "text"),
      desc: attr(n, "content-desc"),
      id: attr(n, "resource-id"),
      bounds,
      clickable: attr(n, "clickable") === "true",
      checked: attr(n, "checked") === "true",
      visible: bounds[2] > bounds[0] && bounds[3] > bounds[1],
    });
  }
  return out;
}

export const center = (n) => [Math.round((n.bounds[0] + n.bounds[2]) / 2), Math.round((n.bounds[1] + n.bounds[3]) / 2)];

export const fmtNode = (n) =>
  `[${n.bounds.join(",")}] ${n.id ? "id=" + n.id.split("/").pop() : ""} ${n.text ? "t=" + JSON.stringify(fix(n.text, 80)) : ""}${
    n.desc ? " d=" + JSON.stringify(fix(n.desc, 60)) : ""
  }${n.clickable ? " clickable" : ""}${n.checked ? " checked" : ""}`.replace(/\s+/g, " ");

/** tap/wait selector: visible node whose resource-id equals or ends with "/<id>" and whose text or desc matches the regex (case-insensitive). */
export function nodeMatches(n, sel) {
  if (!n.visible) return false;
  if (sel.id && !(n.id === sel.id || n.id.endsWith("/" + sel.id))) return false;
  if (sel.text) {
    const re = new RegExp(sel.text, "i");
    if (!re.test(n.text) && !re.test(n.desc)) return false;
  }
  return !!(sel.id || sel.text);
}

/** assert matcher: first visible node whose text, content-desc or resource-id matches the regex (case-insensitive). */
export function anyMatch(nodes, pattern) {
  const re = new RegExp(pattern, "i");
  return nodes.find((n) => n.visible && (re.test(n.text) || re.test(n.desc) || re.test(n.id)));
}

/** Evaluate one assert step against a dump. Returns one {label, ok, detail} per pattern. */
export function evaluateAssert(nodes, { present = [], absent = [] }, label) {
  const out = [];
  for (const pat of present) {
    const hit = anyMatch(nodes, pat);
    out.push({ label: `${label}: present /${pat}/`, ok: !!hit, detail: hit ? fmtNode(hit) : "no visible node matched" });
  }
  for (const pat of absent) {
    const hit = anyMatch(nodes, pat);
    out.push({ label: `${label}: absent /${pat}/`, ok: !hit, detail: hit ? `found ${fmtNode(hit)}` : "no node matched" });
  }
  return out;
}

/** Nodes worth listing for `ui`, optionally filtered by a regex over text/desc/id. */
export function listNodes(nodes, find) {
  const all = nodes.filter((n) => n.visible && (n.text || n.desc || n.clickable || n.id));
  if (!find) return { all, sel: all };
  const re = new RegExp(find, "i");
  return { all, sel: all.filter((n) => re.test(n.text) || re.test(n.desc) || re.test(n.id)) };
}
