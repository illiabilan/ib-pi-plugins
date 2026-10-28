/**
 * Per-invocation Slack session: the id -> name cache, the mention directory, channel
 * resolution and mention linking. Both caches persist on disk between runs in
 * $XDG_CACHE_HOME/slack-cli (default ~/.cache/slack-cli), mode 0700/0600.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { failed } from "./client.mjs";
import { addHandle, emptyDir, hasMentionCandidates, indexUser, keyVariants, normKey, pendingNames, substitute } from "./mentions.mjs";

/** How long cached group/channel lists in the directory are reused before a refresh. */
export const DIR_TTL_MS = 24 * 3600 * 1000;

export function cacheDir(env = process.env) {
  const base = env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(base, "slack-cli");
}

export class Session {
  /** @param {import("./client.mjs").Client} client */
  constructor(client, env = process.env) {
    this.client = client;
    this.dir = cacheDir(env);
    this.namesFile = join(this.dir, "slack-names.json");
    this.dirFile = join(this.dir, "slack-directory.json");
    this.names = null;
    this.directory = null;
    this.authIds = null;
    /** Names already searched in this run: never search the same miss twice. */
    this.searched = new Set();
    /** Channels whose membership was already pulled in this run. */
    this.membersLearned = new Set();
  }

  /* ------------------------------------------------------------ name cache */

  loadNames() {
    if (this.names) return this.names;
    try {
      this.names = JSON.parse(readFileSync(this.namesFile, "utf8"));
    } catch {
      this.names = { users: {}, channels: {} };
    }
    if (!this.names || typeof this.names !== "object") this.names = { users: {}, channels: {} };
    this.names.users ??= {};
    this.names.channels ??= {};
    return this.names;
  }

  writeCache(file, data) {
    try {
      // 0700/0600: maps Slack ids to colleagues' real names and private channel names.
      // Not a secret, but other people's data; no reason for other accounts to read it.
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
    } catch {
      /* cache is best-effort */
    }
  }

  saveNames() {
    this.writeCache(this.namesFile, this.names ?? { users: {}, channels: {} });
  }

  /** Resolve user ids to display names, filling the cache with one users.info per miss. */
  async resolveUsers(ids) {
    const c = this.loadNames();
    const misses = [...new Set([...ids])].filter((id) => id && !c.users[id]);
    let changed = false;
    for (const id of misses) {
      const r = await this.client.call("users.info", { user: id });
      if (r.ok && r.user) {
        c.users[id] = r.user.profile?.display_name || r.user.profile?.real_name || r.user.name || id;
        changed = true;
      } else {
        c.users[id] = id; // negative-cache for this run so a dead id is not refetched per message
      }
    }
    if (changed) this.saveNames();
  }

  userName(id) {
    return this.loadNames().users[id] || id;
  }

  /** "#channel" for channels, "@user (DM)" for DMs, "name (group DM)" for mpims. Cached. */
  async channelLabel(id) {
    if (!id) return "?";
    const c = this.loadNames();
    if (c.channels[id]) return c.channels[id];
    const r = await this.client.call("conversations.info", { channel: id });
    let label = id;
    if (r.ok && r.channel) {
      const ch = r.channel;
      if (ch.is_im && ch.user) {
        await this.resolveUsers([ch.user]);
        label = `@${this.userName(ch.user)} (DM)`;
      } else if (ch.is_mpim) {
        label = `${ch.name ?? "group DM"} (group DM)`;
      } else if (ch.name) {
        label = `#${ch.name}`;
      }
    }
    c.channels[id] = label;
    this.saveNames();
    return label;
  }

  /** Channel id (C/D/G...) as-is, or `#name`/`name` looked up via conversations.list (bounded paging). */
  async resolveChannel(ref) {
    const r = String(ref).trim().replace(/^#/, "");
    if (/^[CDG][A-Z0-9]+$/.test(r)) return r;
    let cursor;
    for (let i = 0; i < 20; i++) {
      const res = await this.client.call("conversations.list", { limit: 1000, exclude_archived: true, types: "public_channel,private_channel", cursor });
      if (!res.ok) {
        if (res.error === "invalid_auth" || res.error === "not_authed") throw failed("conversations.list", res);
        return null;
      }
      for (const ch of res.channels ?? []) if (ch.name === r) return ch.id;
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return null;
  }

  /* ------------------------------------------------------------- directory */

  loadDirCache() {
    try {
      const d = JSON.parse(readFileSync(this.dirFile, "utf8"));
      if (!d?.handles) return null;
      d.ambiguous ??= {};
      d.groups ??= {};
      d.chans ??= {};
      d.labels ??= {};
      return d;
    } catch {
      return null;
    }
  }

  /**
   * Never page the whole member list (on a real workspace users.list is 40+ pages of mostly
   * deactivated accounts). The directory is built lazily from names already seen while reading,
   * one targeted search per unknown name, and the membership of the channel being posted to.
   */
  getDirectory() {
    if (this.directory) return this.directory;
    const d = this.loadDirCache() ?? emptyDir();
    for (const [id, name] of Object.entries(this.loadNames().users)) {
      if (!/^[UW][A-Z0-9]+$/.test(id) || name === id) continue;
      d.labels[id] ??= name;
      for (const k of keyVariants(name)) addHandle(d, k, id);
    }
    this.directory = d;
    return d;
  }

  async getAuthIds() {
    if (this.authIds) return this.authIds;
    const r = await this.client.call("auth.test", {});
    this.authIds = r.ok ? { team: r.team_id, enterprise: r.enterprise_id } : {};
    return this.authIds;
  }

  async searchUsers(query) {
    const ids = await this.getAuthIds();
    return this.client.searchUsers([ids.enterprise, ids.team], query);
  }

  /** Fallback when search is unavailable: the people actually in the target channel. */
  async learnChannelMembers(dir, channel) {
    if (this.membersLearned.has(channel)) return;
    this.membersLearned.add(channel);
    const ids = [];
    let cursor;
    for (let i = 0; i < 2; i++) {
      const r = await this.client.call("conversations.members", { channel, limit: 1000, cursor });
      if (!r.ok) break;
      ids.push(...(r.members ?? []));
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    const unknown = ids.filter((id) => !dir.labels[id]).slice(0, 600);
    for (let i = 0; i < unknown.length; i += 100) {
      const r = await this.client.call("users.info", { users: unknown.slice(i, i + 100).join(",") });
      if (!r.ok) break;
      for (const u of r.users ?? []) indexUser(dir, u);
    }
  }

  async ensureGroups(dir) {
    if (dir.groupsAt && Date.now() - dir.groupsAt < DIR_TTL_MS) return;
    const g = await this.client.call("usergroups.list", {});
    if (!g.ok) return;
    for (const ug of g.usergroups ?? []) {
      if (!ug?.id) continue;
      for (const k of keyVariants(String(ug.handle ?? ""))) dir.groups[k] ??= ug.id;
      for (const k of keyVariants(String(ug.name ?? ""))) dir.groups[k] ??= ug.id;
    }
    dir.groupsAt = Date.now();
  }

  async ensureChans(dir) {
    if (dir.chansAt && Date.now() - dir.chansAt < DIR_TTL_MS) return;
    let cursor;
    for (let i = 0; i < 5; i++) {
      const r = await this.client.call("conversations.list", { limit: 1000, exclude_archived: true, types: "public_channel,private_channel", cursor });
      if (!r.ok) return;
      for (const ch of r.channels ?? []) if (ch?.name && ch.id) dir.chans[ch.name.toLowerCase()] ??= ch.id;
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    dir.chansAt = Date.now();
  }

  /**
   * Rewrite `@name` / `#channel` into Slack entity markup.
   * Free when the text has no candidates or every name is already known. Otherwise: one
   * targeted search per unknown name, then the target channel's membership as a fallback.
   * Anything still unknown stays literal text and is reported.
   */
  async linkMentions(text, channel) {
    if (!text || !hasMentionCandidates(text)) return { text, linked: [], unresolved: [] };
    const dir = this.getDirectory();
    let res = substitute(text, dir);
    // Unknown #words only trigger a (TTL-bounded) channel-list refresh, never a report.
    const chanRefreshUseful = res.unknownChans.length && !(dir.chansAt && Date.now() - dir.chansAt < DIR_TTL_MS);
    if (!res.unresolved.length && !chanRefreshUseful) return res;

    let learned = false;
    const { users, chans } = pendingNames(res);
    if (chans.length && chanRefreshUseful) {
      await this.ensureChans(dir);
      learned = true;
    }
    if (users.length) {
      await this.ensureGroups(dir); // @design and friends
      for (const name of users) {
        const key = normKey(name);
        if (this.searched.has(key)) continue;
        this.searched.add(key);
        for (const u of await this.searchUsers(name)) indexUser(dir, u);
      }
      learned = true;
      let after = substitute(text, dir);
      if (after.unresolved.length && channel) {
        await this.learnChannelMembers(dir, channel);
        after = substitute(text, dir);
      }
      res = after;
    } else {
      res = substitute(text, dir);
    }
    if (learned) {
      dir.at = Date.now();
      this.writeCache(this.dirFile, dir);
    }
    return res;
  }
}
