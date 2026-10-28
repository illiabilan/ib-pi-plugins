/**
 * Duplicate detection (local, deterministic: no API calls, no LLM).
 *
 * score = 0.65*Jaccard(summary tokens) + 0.35*Dice(summary trigrams), nudged by description overlap
 * (0.85*summary + 0.15*description) when both issues have one. Inverted-index prefilter, union-find
 * clustering, canonical = most progressed > most linked > oldest, template-series detection.
 */
import { day, descText } from "./format.mjs";

const STOPWORDS = new Set(
  ("a an the and or but if then than that this these those there here is are was were be been being am" +
    " do does did doing have has had having will would shall should can could may might must" +
    " i we you he she it they them us our your their my me his her its" +
    " of in on at to for from by with without into onto over under about as via per" +
    " not no yes so such own same other another each any all both more most some" +
    " issue issues ticket tickets story stories task tasks bug bugs epic epics chore spike" +
    " jira please need needs needed want wants should when while during after before").split(/\s+/),
);

/** Cheap suffix stemmer: enough to make "banners"/"banner" and "loading"/"load" collide. */
function stem(w) {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && (w.endsWith("ing") || w.endsWith("ers"))) return w.slice(0, -3);
  if (w.length > 3 && (w.endsWith("es") || w.endsWith("ed"))) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function normalizeText(s) {
  return String(s)
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, " ") // issue keys carry no semantic signal
    .replace(/https?:\/\/\S+/g, " ")
    .toLowerCase()
    // Keep version/decimal numbers as one token so "gradle 8.7" and "gradle 8.9" stay distinct.
    .replace(/(\d)[.,](\d)/g, "$1p$2")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenSet(s, maxTokens = 200) {
  const out = new Set();
  for (const w of normalizeText(s).split(" ")) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.add(stem(w));
    if (out.size >= maxTokens) break;
  }
  return out;
}

function trigrams(s) {
  const t = ` ${normalizeText(s)} `;
  const out = new Set();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

function overlap(a, b) {
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  const inter = overlap(a, b);
  return inter / (a.size + b.size - inter);
}
function dice(a, b) {
  if (!a.size || !b.size) return 0;
  return (2 * overlap(a, b)) / (a.size + b.size);
}

/** Issue (as returned by search/backlog) -> scoring document. */
export function toDoc(i) {
  const f = i.fields ?? {};
  const summary = String(f.summary ?? "");
  const desc = descText(f.description).slice(0, 4000);
  const dupLinks = new Set();
  for (const l of f.issuelinks ?? []) {
    const other = l.outwardIssue ?? l.inwardIssue;
    if (other?.key && /duplicate/i.test(String(l.type?.name ?? ""))) dupLinks.add(other.key);
  }
  return {
    key: i.key,
    summary,
    status: f.status?.name ?? "?",
    statusCategory: f.status?.statusCategory?.name ?? "?",
    type: f.issuetype?.name ?? "?",
    assignee: f.assignee?.displayName ?? "Unassigned",
    reporter: f.reporter?.displayName ?? "?",
    created: day(f.created),
    updated: day(f.updated),
    labels: Array.isArray(f.labels) ? f.labels : [],
    linkCount: (f.issuelinks ?? []).length,
    dupLinks,
    toks: tokenSet(summary),
    tris: trigrams(summary),
    descToks: tokenSet(desc, 300),
  };
}

function pairScore(x, y) {
  const sum = 0.65 * jaccard(x.toks, y.toks) + 0.35 * dice(x.tris, y.tris);
  const bothDesc = x.descToks.size >= 3 && y.descToks.size >= 3;
  const desc = bothDesc ? jaccard(x.descToks, y.descToks) : 0;
  return { score: bothDesc ? 0.85 * sum + 0.15 * desc : sum, sum, desc };
}

/** Union-find clustering over all pairs at or above the threshold. */
export function findDuplicateClusters(docs, threshold) {
  const n = docs.length;
  // Inverted index prefilter: only compare issues that share a reasonably rare token.
  const postings = new Map();
  for (let i = 0; i < n; i++)
    for (const t of docs[i].toks) {
      let p = postings.get(t);
      if (!p) postings.set(t, (p = []));
      p.push(i);
    }
  const commonCap = Math.max(8, Math.floor(n * 0.35));
  const pairs = [];
  let compared = 0;
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    seen.clear();
    for (const t of docs[i].toks) {
      const p = postings.get(t);
      if (p.length > commonCap) continue; // stopword-like token in this dataset
      for (const j of p) {
        if (j <= i || seen.has(j)) continue;
        seen.add(j);
        compared++;
        const s = pairScore(docs[i], docs[j]);
        if (s.score >= threshold) pairs.push({ ...s, a: i, b: j });
      }
    }
  }

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const p of pairs) parent[find(p.a)] = find(p.b);

  const groups = new Map();
  for (const p of pairs)
    for (const idx of [p.a, p.b]) {
      const root = find(idx);
      const g = groups.get(root) ?? [];
      if (!g.includes(idx)) g.push(idx);
      groups.set(root, g);
    }

  const bestPair = new Map();
  for (const p of pairs) {
    const k = find(p.a);
    const cur = bestPair.get(k);
    if (!cur || p.score > cur.score) bestPair.set(k, p);
  }

  const CATEGORY_RANK = { Done: 3, "In Progress": 2, "To Do": 1 };
  const clusters = [...groups.entries()].map(([root, idxs]) => {
    const members = idxs.map((i) => docs[i]);
    const canonical = [...members].sort(
      (a, b) =>
        (CATEGORY_RANK[b.statusCategory] ?? 0) - (CATEGORY_RANK[a.statusCategory] ?? 0) ||
        b.linkCount - a.linkCount ||
        a.created.localeCompare(b.created),
    )[0];
    const alreadyLinked = members.every((m) =>
      members.filter((o) => o.key !== m.key).every((o) => m.dupLinks.has(o.key) || o.dupLinks.has(m.key)),
    );
    // Template series ("... for the Redeem screen" / "... for the Save screen") look almost
    // identical lexically but are distinct work: every member carries a token no sibling has.
    const shared = new Set([...members[0].toks].filter((t) => members.every((m) => m.toks.has(t))));
    const distinct = members.map((m) => ({
      key: m.key,
      only: [...m.toks].filter((t) => !shared.has(t) && members.every((o) => o.key === m.key || !o.toks.has(t))),
    }));
    const siblingSeries = members.length >= 2 && distinct.every((d) => d.only.length > 0);
    return { members, canonical, maxScore: bestPair.get(root)?.score ?? 0, alreadyLinked, siblingSeries, distinct };
  });
  clusters.sort((a, b) => b.maxScore - a.maxScore || b.members.length - a.members.length);
  return { clusters, pairCount: pairs.length, compared };
}

/** JSON-safe view of a cluster (Sets -> arrays, scoring internals dropped). */
export function clusterJson(c) {
  const doc = (m) => ({
    key: m.key, summary: m.summary, status: m.status, statusCategory: m.statusCategory, type: m.type,
    assignee: m.assignee, created: m.created, linkCount: m.linkCount, dupLinks: [...m.dupLinks],
  });
  return {
    members: c.members.map(doc),
    canonical: c.canonical.key,
    maxScore: Number(c.maxScore.toFixed(4)),
    alreadyLinked: c.alreadyLinked,
    siblingSeries: c.siblingSeries,
    distinct: c.distinct,
  };
}
