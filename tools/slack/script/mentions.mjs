/**
 * Mention linking (pure: text + directory -> text).
 *
 * Slack only renders a mention when the message text contains the entity markup
 * `<@U123>` / `<#C123>` / `<!here>`. Plain `@ostap` is posted as literal text and notifies
 * nobody. So before posting, `@name` and `#channel` written in ordinary prose are rewritten
 * into that markup.
 *
 * A token that does not resolve, or that is ambiguous between two people, is left exactly as
 * written and reported, so nobody is silently mentioned by accident.
 *
 * Directory shape:
 *   { at, handles: {normName: userId}, ambiguous: {normName: true}, groups: {handle: subteamId},
 *     groupsAt?, chans: {name: channelId}, chansAt?, labels: {userId: displayLabel} }
 */

export const normKey = (s) => s.trim().toLowerCase().replace(/^@/, "");

/** `Ostap Bender` also answers to `ostapbender`, `ostap.bender`, `ostap-bender`, `ostap_bender`. */
export function keyVariants(raw) {
  const base = normKey(raw);
  if (!base) return [];
  return [...new Set([base, base.replace(/\s+/g, ""), base.replace(/\s+/g, "."), base.replace(/\s+/g, "-"), base.replace(/\s+/g, "_")])];
}

export function addHandle(dir, key, id) {
  if (!key || !id) return;
  const prev = dir.handles[key];
  if (prev && prev !== id) {
    dir.ambiguous[key] = true;
    return;
  }
  dir.handles[key] = id;
}

export function indexUser(dir, u) {
  if (!u?.id || u.deleted) return;
  const p = u.profile ?? {};
  dir.labels[u.id] = p.display_name || p.real_name || u.name || u.id;
  for (const field of [u.name, p.display_name, p.display_name_normalized, p.real_name, p.real_name_normalized])
    for (const k of keyVariants(String(field ?? ""))) addHandle(dir, k, u.id);
}

export function emptyDir() {
  return { at: Date.now(), handles: {}, ambiguous: {}, groups: {}, chans: {}, labels: {} };
}

/** Broadcast mentions have fixed markup and need no lookup. */
export const BROADCASTS = { here: "<!here>", channel: "<!channel>", everyone: "<!everyone>" };

/**
 * Candidate scanner. The first alternative swallows fenced/inline code and text that is
 * already entity markup, so `<@U123>` stays untouched and a shell snippet full of `@` is not
 * rewritten. The lookbehind keeps email addresses and URLs out.
 */
const MENTION_RE =
  /(```[\s\S]*?```|`[^`\n]*`|<[^>\n]{1,200}>)|(?<![A-Za-z0-9._%+\-\/])([@#])(?:"([^"\n]{1,80})"|([A-Za-z0-9][A-Za-z0-9._\-]{0,60}))/g;

/** Trailing punctuation is part of the sentence, not of the name: `@ostap,` -> `ostap`. */
function candidateForms(word) {
  const forms = [word];
  let w = word;
  while (/[._\-]$/.test(w)) {
    w = w.slice(0, -1);
    if (w) forms.push(w);
  }
  return forms;
}

/** Does this text contain anything worth a directory lookup? */
export function hasMentionCandidates(text) {
  MENTION_RE.lastIndex = 0;
  for (const m of text.matchAll(MENTION_RE)) if (!m[1]) return true;
  return false;
}

/**
 * @returns {{text:string, linked:{raw:string, code:string, label:string}[], unresolved:string[], unknownChans:string[]}}
 * `unknownChans` lists `#words` with no match; they are not "unresolved" (issue numbers and hashtags
 * are normal text) but tell the caller a channel-list refresh might link them.
 */
export function substitute(text, dir) {
  const linked = [];
  const unresolved = [];
  const unknownChans = [];

  const out = text.replace(MENTION_RE, (whole, skip, sigil, quoted, bare) => {
    if (skip) return whole; // code span / fence / existing entity markup
    const word = quoted ?? bare ?? "";
    if (!word) return whole;
    const raw = `${sigil}${quoted ? `"${word}"` : word}`;

    if (sigil === "@") {
      for (const form of candidateForms(word)) {
        const key = normKey(form);
        const suffix = word.slice(form.length); // punctuation we trimmed off, put back verbatim

        const broadcast = BROADCASTS[key];
        if (broadcast) {
          linked.push({ raw: `@${form}`, code: broadcast, label: `everyone in the channel (@${form})` });
          return `${broadcast}${suffix}`;
        }
        if (dir.ambiguous[key]) {
          unresolved.push(`${raw} (matches more than one person — use the exact handle)`);
          return whole;
        }
        const uid = dir.handles[key];
        if (uid) {
          linked.push({ raw: `@${form}`, code: `<@${uid}>`, label: dir.labels[uid] ?? uid });
          return `<@${uid}>${suffix}`;
        }
        const gid = dir.groups[key];
        if (gid) {
          linked.push({ raw: `@${form}`, code: `<!subteam^${gid}>`, label: `user group @${form}` });
          return `<!subteam^${gid}>${suffix}`;
        }
      }
      unresolved.push(raw);
      return whole;
    }

    // #channel
    for (const form of candidateForms(word)) {
      const cid = dir.chans[normKey(form)];
      if (cid) {
        linked.push({ raw: `#${form}`, code: `<#${cid}>`, label: `#${form}` });
        return `<#${cid}>${word.slice(form.length)}`;
      }
    }
    unknownChans.push(word);
    return whole; // an unknown #word is just text (issue numbers, hashtags)
  });

  return { text: out, linked, unresolved, unknownChans };
}

/** The bare names still unresolved after a substitution pass. */
export function pendingNames(res) {
  const users = [];
  const chans = [];
  for (const u of res.unresolved) {
    const name = u.replace(/^[@#]/, "").replace(/^"|"$/g, "").replace(/ \(.*\)$/, "");
    if (!name) continue;
    (u.startsWith("#") ? chans : users).push(name);
  }
  for (const c of res.unknownChans ?? []) chans.push(c);
  return { users, chans };
}
