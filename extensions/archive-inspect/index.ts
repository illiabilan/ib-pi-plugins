/**
 * archive_inspect — JVM artifact / archive inspector for Pi.
 *
 * Replaces the multi-step `unzip`/`tar`/`jar`/`javap` bash pipelines an agent otherwise
 * has to write when it needs to know what a third-party dependency actually does and no
 * source jar is available, e.g.:
 *
 *   cd /tmp/x && mkdir -p cls && unzip -qo ~/.gradle/caches/.../foo-1.2.3.jar -d cls "*.class" \
 *     && for f in $(find cls -name "*.class"); do javap -classpath cls "$f"; done
 *   ls ~/.gradle/caches/modules-2/files-2.1 | grep -viE "^(org\.|androidx|com\.android)"
 *
 * Design notes:
 *  - Zip/jar/aar/apk reading is implemented in-process (central directory + inflateRaw),
 *    so listing/searching never extracts anything and never leaves litter in /tmp.
 *  - Only `signatures` (and only for nested-jar/odd-layout archives) needs a temp dir;
 *    it is always created with mkdtemp(arcx-) and removed in a finally block.
 *  - Nothing is ever written into the Gradle/Maven caches: `extract` requires an explicit
 *    destDir and refuses one that lives inside those caches.
 *  - Every result that comes from a degraded code path is tagged (`source: ...`) so the
 *    agent can tell precise output from best-effort output.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/* ------------------------------------------------------------------ caps */

const MAX_CHARS = 40_000; // hard ceiling on returned text
const DEF_LIST = 200; // list: entries printed
const DEF_CLASSES = 12; // signatures: classes dumped
const DEF_FIND = 100; // find_class: classes printed
const DEF_STRINGS = 100; // strings: matching lines printed
const DEF_LOCATE = 60; // locate_artifact: rows printed
const MAX_MEMBERS_PER_CLASS = 80;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024; // refuse to inflate a single entry bigger than this
const MAX_STRINGS_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_STRINGS_SCAN_ENTRIES = 5_000;
const MAX_NESTED_JARS = 12;
const MAX_EXTRACT_BYTES = 256 * 1024 * 1024;
const MAX_LOCATE_DIRS = 60_000; // walk budget for locate_artifact
const JAVAP_TIMEOUT_MS = 30_000;

/* ------------------------------------------------------------- utilities */

class ArcError extends Error {}

function human(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}G`;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * unzip-style glob: `*` matches any characters INCLUDING `/` (this mirrors
 * `unzip archive "*.class"`, which matches nested entries — a `*`-does-not-cross-slash
 * implementation would silently match nothing for the most common pattern of all).
 * `?` matches a single character. Matching is case-sensitive unless `ci` is set.
 */
function globToRegExp(glob: string, ci = false): RegExp {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, ci ? "i" : "");
}

function hasWildcard(s: string): boolean {
  return s.includes("*") || s.includes("?");
}

/** Resolve an archive path that may contain `*` (e.g. the gradle cache hash dir). */
async function resolveArchivePath(raw: string): Promise<string> {
  const p = expandHome(raw);
  if (!hasWildcard(p)) {
    if (!existsSync(p)) throw new ArcError(`archive not found: ${p}`);
    const st = await fs.stat(p);
    if (st.isDirectory()) throw new ArcError(`archive is a directory, not an archive file: ${p}`);
    return p;
  }
  const segs = p.split(sep);
  let cands: string[] = [p.startsWith(sep) ? sep : "."];
  for (const seg of segs) {
    if (seg === "") continue;
    if (!hasWildcard(seg)) {
      cands = cands.map((c) => join(c, seg)).filter((c) => existsSync(c));
      continue;
    }
    const re = globToRegExp(seg);
    const next: string[] = [];
    for (const c of cands) {
      let names: string[] = [];
      try {
        names = await fs.readdir(c);
      } catch {
        continue;
      }
      for (const n of names) if (re.test(n)) next.push(join(c, n));
    }
    cands = next;
    if (cands.length > 200) throw new ArcError(`archive glob '${raw}' matches too many paths (${cands.length}); be more specific`);
  }
  const files: string[] = [];
  for (const c of cands) {
    try {
      if ((await fs.stat(c)).isFile()) files.push(c);
    } catch {
      /* ignore */
    }
  }
  if (files.length === 0) throw new ArcError(`archive glob '${raw}' matched no file`);
  if (files.length > 1)
    throw new ArcError(
      `archive glob '${raw}' matched ${files.length} files; pick one:\n${files.slice(0, 20).map((f) => `  ${f}`).join("\n")}`,
    );
  return files[0]!;
}

function truncateText(text: string, note: string): string {
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, MAX_CHARS)}\n... [output truncated at ${MAX_CHARS} chars. ${note}]`;
}

let abortSignal: AbortSignal | undefined; // set per tool call so child processes honour Esc

function run(cmd: string, args: string[], timeout = JAVAP_TIMEOUT_MS): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024, encoding: "utf8", signal: abortSignal }, (err: any, stdout, stderr) => {
      res({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/**
 * Buffer-returning variant — required for tar entry data: decoding child stdout as a
 * string and re-encoding it would corrupt any non-UTF8 bytes (e.g. .class files).
 */
function runBuffer(cmd: string, args: string[], timeout = JAVAP_TIMEOUT_MS): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((res) => {
    execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: "buffer", signal: abortSignal }, (err: any, stdout: any, stderr: any) => {
      res({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0),
        stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""),
      });
    });
  });
}

/* ------------------------------------------------------------ byte source */

interface ByteSource {
  size: number;
  read(offset: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}

async function fileSource(path: string): Promise<ByteSource> {
  const fh = await fs.open(path, "r");
  const st = await fh.stat();
  return {
    size: st.size,
    async read(offset, length) {
      if (offset < 0) throw new ArcError(`corrupt archive: negative read offset (${offset})`);
      const want = Math.max(0, Math.min(length, st.size - offset));
      if (want === 0) return Buffer.alloc(0);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, offset);
      return bytesRead === want ? buf : buf.subarray(0, bytesRead);
    },
    close: () => fh.close(),
  };
}

function bufferSource(buf: Buffer): ByteSource {
  return {
    size: buf.length,
    async read(offset, length) {
      const start = Math.max(0, Math.min(offset, buf.length));
      return buf.subarray(start, Math.min(buf.length, start + Math.max(0, length)));
    },
    async close() {},
  };
}

/* --------------------------------------------------------------- zip read */

interface ZEntry {
  name: string;
  size: number | null; // uncompressed
  compSize: number | null;
  method: number;
  encrypted: boolean;
  offset: number;
  isDir: boolean;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

async function readZipEntries(src: ByteSource, label: string): Promise<{ entries: ZEntry[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (src.size < 22) throw new ArcError(`${label}: not a zip archive (only ${src.size} bytes; truncated or wrong format)`);
  const tailLen = Math.min(src.size, 66_000);
  const tail = await src.read(src.size - tailLen, tailLen);
  let eo = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) {
      eo = i;
      break;
    }
  }
  if (eo < 0)
    throw new ArcError(
      `${label}: corrupt or not a zip archive — end-of-central-directory record not found (file may be truncated, or it is a tar/gzip/other format)`,
    );

  let count = tail.readUInt16LE(eo + 10);
  let cdSize = tail.readUInt32LE(eo + 12);
  let cdOffset = tail.readUInt32LE(eo + 16);

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eo - 20;
    let ok = false;
    if (loc >= 0 && tail.readUInt32LE(loc) === SIG_LOC64) {
      const z64Off = Number(tail.readBigUInt64LE(loc + 8));
      const z64 = await src.read(z64Off, 56);
      if (z64.length >= 56 && z64.readUInt32LE(0) === SIG_EOCD64) {
        count = Number(z64.readBigUInt64LE(32));
        cdSize = Number(z64.readBigUInt64LE(40));
        cdOffset = Number(z64.readBigUInt64LE(48));
        ok = true;
      }
    }
    if (!ok) warnings.push("zip64 markers present but zip64 end-of-central-directory could not be read; entry list may be incomplete");
  }

  if (cdOffset + cdSize > src.size) {
    warnings.push(`central directory extends past end of file (truncated archive); reading what is available`);
    cdSize = Math.max(0, src.size - cdOffset);
  }
  const cd = await src.read(cdOffset, cdSize);
  const entries: ZEntry[] = [];
  let p = 0;
  while (p + 46 <= cd.length) {
    if (cd.readUInt32LE(p) !== SIG_CEN) {
      warnings.push(`central directory record ${entries.length + 1} has a bad signature; stopping (corrupt archive)`);
      break;
    }
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let compSize: number | null = cd.readUInt32LE(p + 20);
    let size: number | null = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");

    // zip64 extended information extra field
    if (size === 0xffffffff || compSize === 0xffffffff || offset === 0xffffffff) {
      const ex = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      let q = 0;
      while (q + 4 <= ex.length) {
        const id = ex.readUInt16LE(q);
        const len = ex.readUInt16LE(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (size === 0xffffffff && r + 8 <= ex.length) {
            size = Number(ex.readBigUInt64LE(r));
            r += 8;
          }
          if (compSize === 0xffffffff && r + 8 <= ex.length) {
            compSize = Number(ex.readBigUInt64LE(r));
            r += 8;
          }
          if (offset === 0xffffffff && r + 8 <= ex.length) {
            offset = Number(ex.readBigUInt64LE(r));
            r += 8;
          }
          break;
        }
        q += 4 + len;
      }
    }

    entries.push({
      name,
      size,
      compSize,
      method,
      encrypted: (flags & 0x1) !== 0 || (flags & 0x40) !== 0,
      offset,
      isDir: name.endsWith("/"),
    });
    p += 46 + nameLen + extraLen + commentLen;
    if (entries.length > 400_000) {
      warnings.push("stopped after 400000 central directory records (absurdly large archive)");
      break;
    }
  }
  if (count && entries.length < count)
    warnings.push(`central directory declares ${count} entries but only ${entries.length} could be parsed (truncated/corrupt archive)`);
  return { entries, warnings };
}

/**
 * Degraded recovery path: when the end-of-central-directory record / central directory is
 * missing (a truncated download, a partially-copied jar), scan forward for local file headers
 * instead. Results are strictly worse than a real central-directory read — names and sizes come
 * from the local headers, entries whose data was cut off are unrecoverable, and streamed entries
 * (bit 3, sizes in a trailing data descriptor) cannot be sized — so every caller tags this
 * output as `source: local-header-scan`. Empirically an agent otherwise hand-rolls this in
 * python, so it is worth doing here, honestly labelled.
 */
const LOC_SIG_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

async function scanLocalHeaders(src: ByteSource, label: string): Promise<{ entries: ZEntry[]; warnings: string[] }> {
  const entries: ZEntry[] = [];
  const warnings: string[] = [];
  const CHUNK = 1 << 20;
  let lost = 0;
  let streamed = 0;
  let pos = 0;
  let buf = await src.read(0, Math.min(CHUNK, src.size));
  let bufStart = 0;
  const byteAt = async (offset: number, length: number): Promise<Buffer> => {
    if (offset >= bufStart && offset + length <= bufStart + buf.length) return buf.subarray(offset - bufStart, offset - bufStart + length);
    bufStart = offset;
    buf = await src.read(offset, Math.max(length, CHUNK));
    return buf.subarray(0, length);
  };
  while (pos + 30 <= src.size) {
    const head = await byteAt(pos, 30);
    if (head.length < 30) break;
    if (head.readUInt32LE(0) !== SIG_LOC) {
      // Resync by jumping to the next "PK\x03\x04" in the current window rather than advancing a
      // byte at a time — a byte-wise scan over a large non-zip file would take minutes.
      const window = await byteAt(pos, Math.min(CHUNK, src.size - pos));
      const idx = window.indexOf(LOC_SIG_BYTES, 1);
      pos = idx === -1 ? pos + Math.max(1, window.length - 3) : pos + idx;
      continue;
    }
    const flags = head.readUInt16LE(6);
    const method = head.readUInt16LE(8);
    const compSize = head.readUInt32LE(18);
    const size = head.readUInt32LE(22);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const nameBuf = await byteAt(pos + 30, nameLen);
    if (nameBuf.length < nameLen) {
      lost++;
      break; // header itself is cut off
    }
    const name = nameBuf.toString("utf8");
    const dataOff = pos + 30 + nameLen + extraLen;
    const hasDescriptor = (flags & 0x08) !== 0 && compSize === 0;
    if (hasDescriptor) {
      streamed++;
      entries.push({ name, size: null, compSize: null, method, encrypted: (flags & 0x1) !== 0 || (flags & 0x40) !== 0, offset: pos, isDir: name.endsWith("/") });
      pos += 30 + nameLen + extraLen; // cannot skip the data safely; resync on the next signature
      continue;
    }
    if (dataOff + compSize > src.size) lost++;
    entries.push({ name, size, compSize, method, encrypted: (flags & 0x1) !== 0 || (flags & 0x40) !== 0, offset: pos, isDir: name.endsWith("/") });
    pos = dataOff + compSize;
    if (entries.length > 200_000) {
      warnings.push("stopped after 200000 recovered local headers");
      break;
    }
  }
  if (entries.length === 0) throw new ArcError(`${label}: no zip data found at all (no central directory and no local file headers) — this is not a zip/jar/aar/apk archive`);
  warnings.push(
    `central directory unreadable; recovered ${entries.length} entries by scanning local file headers ` +
      `(source: local-header-scan — DEGRADED: this list may be incomplete or out of order` +
      `${lost ? `, ${lost} entry/entries are cut off by the truncation and cannot be read` : ""}` +
      `${streamed ? `, ${streamed} entry/entries use a trailing data descriptor so their sizes are unknown` : ""})`,
  );
  return { entries, warnings };
}

async function readZipEntryData(src: ByteSource, e: ZEntry, label: string): Promise<Buffer> {
  if (e.encrypted)
    throw new ArcError(
      `${label}: entry '${e.name}' is encrypted (password-protected zip). archive_inspect never prompts for or guesses passwords; entry names/sizes are still listable.`,
    );
  if ((e.size ?? 0) > MAX_ENTRY_BYTES) throw new ArcError(`${label}: entry '${e.name}' is ${human(e.size)} — too large to read (cap ${human(MAX_ENTRY_BYTES)})`);
  const loc = await src.read(e.offset, 30);
  if (loc.length < 30 || loc.readUInt32LE(0) !== SIG_LOC)
    throw new ArcError(`${label}: corrupt archive — bad local header for entry '${e.name}' at offset ${e.offset}`);
  const nameLen = loc.readUInt16LE(26);
  const extraLen = loc.readUInt16LE(28);
  const dataOff = e.offset + 30 + nameLen + extraLen;
  const want = e.compSize ?? 0;
  const comp = await src.read(dataOff, want);
  if (comp.length < want)
    throw new ArcError(
      `${label}: corrupt archive — data for entry '${e.name}' runs past end of file (got ${comp.length} of ${want} bytes at offset ${dataOff}, file is ${src.size} bytes). ` +
        `Either the file is truncated or the local header is damaged (bad name/extra-field length). \`unzip -t\` will confirm.`,
    );
  if (e.method === 0) return comp;
  if (e.method === 8) {
    try {
      return inflateRawSync(comp);
    } catch (err: any) {
      throw new ArcError(`${label}: corrupt deflate stream in '${e.name}' (${err?.message ?? err})`);
    }
  }
  throw new ArcError(`${label}: entry '${e.name}' uses unsupported compression method ${e.method} (only stored/deflate are supported)`);
}

/* ------------------------------------------------------- archive handles */

interface AEntry {
  name: string;
  size: number | null;
  encrypted: boolean;
  isDir: boolean;
}

interface Handle {
  kind: "zip" | "tar";
  label: string;
  /** Provenance of the entry list: "central-directory" is exact; "local-header-scan" is the degraded recovery path. */
  source?: "central-directory" | "local-header-scan";
  entries: AEntry[];
  warnings: string[];
  read(name: string): Promise<Buffer>;
  close(): Promise<void>;
}

async function openZip(path: string): Promise<Handle> {
  const src = await fileSource(path);
  try {
    let entries: ZEntry[];
    let warnings: string[];
    let source: Handle["source"] = "central-directory";
    try {
      ({ entries, warnings } = await readZipEntries(src, basename(path)));
    } catch (err) {
      if (!(err instanceof ArcError)) throw err;
      // Central directory unusable — try the degraded local-header scan before giving up.
      const scanned = await scanLocalHeaders(src, basename(path)).catch(() => null);
      if (!scanned) throw new ArcError(`${(err as Error).message} A local-file-header scan found no recoverable zip data either.${await sniffFormat(src)}`);
      entries = scanned.entries;
      warnings = [`${(err as Error).message}`, ...scanned.warnings];
      source = "local-header-scan";
    }
    const byName = new Map(entries.map((e) => [e.name, e]));
    return {
      kind: "zip",
      label: basename(path),
      source,
      entries: entries.map((e) => ({ name: e.name, size: e.size, encrypted: e.encrypted, isDir: e.isDir })),
      warnings,
      async read(name) {
        const e = byName.get(name);
        if (!e) throw new ArcError(`entry not found in ${basename(path)}: ${name}`);
        return readZipEntryData(src, e, basename(path));
      },
      close: () => src.close(),
    };
  } catch (err) {
    await src.close();
    throw err;
  }
}

/** Identify common non-zip formats so a wrong-format path produces a useful message, not a guess. */
async function sniffFormat(src: ByteSource): Promise<string> {
  try {
    const head = await src.read(0, 8);
    if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return " The file starts with gzip magic — if it is a .tar.gz, pass a path ending in .tar.gz/.tgz so it is read with tar.";
    if (head.length >= 4 && head.readUInt32BE(0) === 0xcafebabe) return " The file is a raw Java .class file, not an archive.";
    if (head.length >= 6 && head.subarray(0, 6).toString("utf8") === "BZh91A") return " The file starts with bzip2 magic (maybe a .tar.bz2).";
    const tarMagic = await src.read(257, 5);
    if (tarMagic.toString("utf8") === "ustar") return " The file is an uncompressed tar — pass a path ending in .tar so it is read with tar.";
  } catch {
    /* best effort only */
  }
  return "";
}

async function openZipBuffer(buf: Buffer, label: string): Promise<Handle> {
  const src = bufferSource(buf);
  const { entries, warnings } = await readZipEntries(src, label);
  const byName = new Map(entries.map((e) => [e.name, e]));
  return {
    kind: "zip",
    label,
    entries: entries.map((e) => ({ name: e.name, size: e.size, encrypted: e.encrypted, isDir: e.isDir })),
    warnings,
    async read(name) {
      const e = byName.get(name);
      if (!e) throw new ArcError(`entry not found in ${label}: ${name}`);
      return readZipEntryData(src, e, label);
    },
    async close() {},
  };
}

const TAR_RE = /\.(tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|tar\.zst)$/i;

async function openTar(path: string): Promise<Handle> {
  const listed = await run("tar", ["-tf", path], 60_000);
  if (listed.code !== 0)
    throw new ArcError(`tar could not read ${basename(path)}: ${(listed.stderr || listed.stdout).trim().slice(0, 400)}`);
  const names = listed.stdout.split("\n").filter((l) => l.length > 0);
  return {
    kind: "tar",
    label: basename(path),
    entries: names.map((n) => ({ name: n, size: null, encrypted: false, isDir: n.endsWith("/") })),
    warnings: ["tar listing does not include per-entry sizes (sizes shown as '-')"],
    async read(name) {
      const r = await runBuffer("tar", ["-xOf", path, name], 60_000);
      if (r.code !== 0) throw new ArcError(`tar could not extract '${name}': ${(r.stderr || "").trim().slice(0, 300)}`);
      return r.stdout;
    },
    async close() {},
  };
}

async function openArchive(path: string): Promise<Handle> {
  if (TAR_RE.test(path)) return openTar(path);
  return openZip(path);
}

/* --------------------------------------------------------- class helpers */

interface ClassRef {
  fqn: string;
  entry: string;
  nested?: string; // nested jar entry name, when the class lives inside e.g. classes.jar
}

function entryToFqn(entry: string): string {
  // tar listings prefix entries with "./" and some zips carry a leading "/": both would
  // otherwise produce a bogus FQN like "..com.example.Foo" that javap can never resolve.
  const clean = entry.replace(/^(\.\/|\/)+/, "");
  return clean.replace(/\.class$/, "").replace(/\//g, ".");
}

function matchClass(pattern: string | undefined, fqn: string): boolean {
  if (!pattern) return true;
  const norm = pattern.replace(/\//g, ".").replace(/\.class$/i, "");
  if (hasWildcard(norm)) {
    const re = globToRegExp(norm);
    const simple = fqn.slice(fqn.lastIndexOf(".") + 1);
    return re.test(fqn) || re.test(simple);
  }
  return fqn.toLowerCase().includes(norm.toLowerCase());
}

/** Collect class entries from an archive, descending into nested jars (aar/classes.jar, libs/*.jar). */
/**
 * Anonymous / synthetic inner classes (Foo$1, Foo$1$2, Foo$$Lambda$3, Kotlin's Foo$special$1)
 * are never part of a library's public API, and on a real jar they were ~half of every match
 * (11 hits for "*EventSource*" of which 6 were anonymous). They are hidden unless the caller's
 * pattern itself mentions '$', with a note saying how many were hidden.
 */
const ANON_CLASS_RE = /\$\d+(\$|$)/;

async function collectClasses(
  h: Handle,
  pattern: string | undefined,
  opts: { scanNested: boolean },
): Promise<{
  classes: ClassRef[];
  nestedScanned: string[];
  nestedHandles: Map<string, Handle>;
  notes: string[];
  anonHidden: number;
}> {
  const notes: string[] = [];
  const classes: ClassRef[] = [];
  const wantAnon = !!pattern && pattern.includes("$");
  let anonHidden = 0;
  const keep = (fqn: string): boolean => {
    if (!matchClass(pattern, fqn)) return false;
    if (!wantAnon && ANON_CLASS_RE.test(fqn)) {
      anonHidden++;
      return false;
    }
    return true;
  };
  for (const e of h.entries) {
    if (e.isDir || !e.name.endsWith(".class")) continue;
    const fqn = entryToFqn(e.name);
    if (keep(fqn)) classes.push({ fqn, entry: e.name });
  }
  const nestedScanned: string[] = [];
  const nestedHandles = new Map<string, Handle>();
  if (opts.scanNested) {
    const jars = h.entries.filter((e) => !e.isDir && /\.(jar|zip)$/i.test(e.name));
    for (const j of jars.slice(0, MAX_NESTED_JARS)) {
      if (j.encrypted) {
        notes.push(`nested jar '${j.name}' is encrypted; skipped`);
        continue;
      }
      try {
        const buf = await h.read(j.name);
        const nh = await openZipBuffer(buf, `${h.label}!${j.name}`);
        nestedHandles.set(j.name, nh);
        nestedScanned.push(j.name);
        for (const e of nh.entries) {
          if (e.isDir || !e.name.endsWith(".class")) continue;
          const fqn = entryToFqn(e.name);
          if (keep(fqn)) classes.push({ fqn, entry: e.name, nested: j.name });
        }
      } catch (err: any) {
        notes.push(`nested jar '${j.name}' could not be read: ${err?.message ?? err}`);
      }
    }
    if (jars.length > MAX_NESTED_JARS) notes.push(`only the first ${MAX_NESTED_JARS} of ${jars.length} nested jars were scanned`);
  }
  classes.sort((a, b) => a.fqn.localeCompare(b.fqn));
  if (anonHidden > 0)
    notes.push(
      `${anonHidden} anonymous/synthetic inner class(es) matching the pattern were hidden (Foo$1, Foo$$Lambda$2, ...); include '$' in classPattern to see them`,
    );
  return { classes, nestedScanned, nestedHandles, notes, anonHidden };
}

/* ---------------------------------------------- class file parse fallback */

interface ParsedMember {
  access: number;
  name: string;
  desc: string;
}
interface ParsedClass {
  access: number;
  thisClass: string;
  superClass: string | null;
  interfaces: string[];
  fields: ParsedMember[];
  methods: ParsedMember[];
}

function parseClassFile(buf: Buffer): ParsedClass {
  if (buf.length < 10 || buf.readUInt32BE(0) !== 0xcafebabe) throw new ArcError("not a Java class file (bad magic)");
  const cpCount = buf.readUInt16BE(8);
  if (cpCount < 2) throw new ArcError(`truncated/invalid class file: empty constant pool (${buf.length} bytes)`);
  const utf8: (string | null)[] = new Array(cpCount).fill(null);
  const classRef: (number | null)[] = new Array(cpCount).fill(null);
  let p = 10;
  for (let i = 1; i < cpCount; i++) {
    const tag = buf.readUInt8(p);
    p += 1;
    switch (tag) {
      case 1: {
        const len = buf.readUInt16BE(p);
        utf8[i] = buf.subarray(p + 2, p + 2 + len).toString("utf8");
        p += 2 + len;
        break;
      }
      case 7:
        classRef[i] = buf.readUInt16BE(p);
        p += 2;
        break;
      case 8:
      case 16:
      case 19:
      case 20:
        p += 2;
        break;
      case 15:
        p += 3;
        break;
      case 3:
      case 4:
      case 9:
      case 10:
      case 11:
      case 12:
      case 17:
      case 18:
        p += 4;
        break;
      case 5:
      case 6:
        p += 8;
        i += 1; // long/double take two constant pool slots
        break;
      default:
        throw new ArcError(`unsupported constant pool tag ${tag} at index ${i}`);
    }
  }
  const clsName = (idx: number): string | null => {
    if (!idx) return null;
    const ni = classRef[idx];
    if (!ni) return null;
    const n = utf8[ni];
    return n ? n.replace(/\//g, ".") : null;
  };
  const access = buf.readUInt16BE(p);
  const thisClass = clsName(buf.readUInt16BE(p + 2));
  if (!thisClass) throw new ArcError("truncated/invalid class file: this_class is not resolvable in the constant pool");
  const superClass = clsName(buf.readUInt16BE(p + 4));
  const ifCount = buf.readUInt16BE(p + 6);
  p += 8;
  const interfaces: string[] = [];
  for (let i = 0; i < ifCount; i++) {
    interfaces.push(clsName(buf.readUInt16BE(p)) ?? "?");
    p += 2;
  }
  const readMembers = (): ParsedMember[] => {
    const n = buf.readUInt16BE(p);
    p += 2;
    const out: ParsedMember[] = [];
    for (let i = 0; i < n; i++) {
      const acc = buf.readUInt16BE(p);
      const name = utf8[buf.readUInt16BE(p + 2)] ?? "?";
      const desc = utf8[buf.readUInt16BE(p + 4)] ?? "?";
      const attrs = buf.readUInt16BE(p + 6);
      p += 8;
      for (let a = 0; a < attrs; a++) {
        const len = buf.readUInt32BE(p + 2);
        p += 6 + len;
      }
      out.push({ access: acc, name, desc });
    }
    return out;
  };
  const fields = readMembers();
  const methods = readMembers();
  return { access, thisClass, superClass, interfaces, fields, methods };
}

function typeFromDesc(d: string, st: { p: number }): string {
  const c = d[st.p++];
  switch (c) {
    case "B":
      return "byte";
    case "C":
      return "char";
    case "D":
      return "double";
    case "F":
      return "float";
    case "I":
      return "int";
    case "J":
      return "long";
    case "S":
      return "short";
    case "Z":
      return "boolean";
    case "V":
      return "void";
    case "[":
      return `${typeFromDesc(d, st)}[]`;
    case "L": {
      const end = d.indexOf(";", st.p);
      const name = d.slice(st.p, end === -1 ? d.length : end);
      st.p = end === -1 ? d.length : end + 1;
      return name.replace(/\//g, ".");
    }
    default:
      return "?";
  }
}

const ACC = {
  PUBLIC: 0x0001,
  PRIVATE: 0x0002,
  PROTECTED: 0x0004,
  STATIC: 0x0008,
  FINAL: 0x0010,
  SYNCHRONIZED: 0x0020,
  BRIDGE: 0x0040,
  VOLATILE: 0x0040,
  TRANSIENT: 0x0080,
  NATIVE: 0x0100,
  INTERFACE: 0x0200,
  ABSTRACT: 0x0400,
  SYNTHETIC: 0x1000,
  ANNOTATION: 0x2000,
  ENUM: 0x4000,
};

function modifiers(acc: number, isMethod: boolean): string {
  const m: string[] = [];
  if (acc & ACC.PUBLIC) m.push("public");
  if (acc & ACC.PROTECTED) m.push("protected");
  if (acc & ACC.PRIVATE) m.push("private");
  if (acc & ACC.STATIC) m.push("static");
  if (acc & ACC.FINAL) m.push("final");
  if (isMethod && acc & ACC.ABSTRACT) m.push("abstract");
  if (isMethod && acc & ACC.SYNCHRONIZED) m.push("synchronized");
  if (isMethod && acc & ACC.NATIVE) m.push("native");
  if (!isMethod && acc & ACC.VOLATILE) m.push("volatile");
  if (!isMethod && acc & ACC.TRANSIENT) m.push("transient");
  return m.join(" ");
}

/** javap-like rendering of a parsed class file (no generics/throws — see the source tag). */
function renderParsedClass(pc: ParsedClass, includePrivate: boolean, memberPattern: string | undefined): string[] {
  const lines: string[] = [];
  const simple = pc.thisClass;
  let kind = "class";
  if (pc.access & ACC.ANNOTATION) kind = "@interface";
  else if (pc.access & ACC.INTERFACE) kind = "interface";
  else if (pc.access & ACC.ENUM) kind = "enum";
  let decl = `${modifiers(pc.access & ~ACC.SYNCHRONIZED, false)} ${kind} ${simple}`.trim();
  if (pc.superClass && pc.superClass !== "java.lang.Object" && kind === "class") decl += ` extends ${pc.superClass}`;
  if (pc.interfaces.length) decl += ` ${kind === "interface" ? "extends" : "implements"} ${pc.interfaces.join(", ")}`;
  lines.push(`${decl} {`);

  const visible = (acc: number) =>
    includePrivate || (acc & ACC.PUBLIC) !== 0 || (acc & ACC.PROTECTED) !== 0 || (pc.access & ACC.INTERFACE) !== 0;
  const memOk = (name: string, rendered: string) => {
    if (!memberPattern) return true;
    if (hasWildcard(memberPattern)) return globToRegExp(memberPattern, true).test(name);
    return rendered.toLowerCase().includes(memberPattern.toLowerCase());
  };

  const body: string[] = [];
  for (const f of pc.fields) {
    if (!visible(f.access) || f.access & ACC.SYNTHETIC) continue;
    const t = typeFromDesc(f.desc, { p: 0 });
    const rendered = `${modifiers(f.access, false)} ${t} ${f.name};`.trim();
    if (memOk(f.name, rendered)) body.push(`  ${rendered}`);
  }
  for (const m of pc.methods) {
    if (!visible(m.access) || m.access & ACC.SYNTHETIC || m.access & ACC.BRIDGE) continue;
    if (m.name === "<clinit>") continue;
    const st = { p: 1 };
    const params: string[] = [];
    while (st.p < m.desc.length && m.desc[st.p] !== ")") params.push(typeFromDesc(m.desc, st));
    st.p += 1;
    const ret = typeFromDesc(m.desc, st);
    // javap prints constructors with the fully-qualified class name; match that so the
    // fallback output diffs cleanly against a javap dump of the same class.
    const rendered =
      m.name === "<init>"
        ? `${modifiers(m.access, true)} ${simple}(${params.join(", ")});`.trim()
        : `${modifiers(m.access, true)} ${ret} ${m.name}(${params.join(", ")});`.trim();
    if (memOk(m.name, rendered)) body.push(`  ${rendered}`);
  }
  if (body.length > MAX_MEMBERS_PER_CLASS) {
    lines.push(...body.slice(0, MAX_MEMBERS_PER_CLASS));
    lines.push(`  ... ${body.length - MAX_MEMBERS_PER_CLASS} more members (use memberPattern to narrow)`);
  } else lines.push(...body);
  lines.push("}");
  return lines;
}

/* ----------------------------------------------------------- javap driver */

async function javapAvailable(): Promise<boolean> {
  if (process.env.ARCX_DISABLE_JAVAP === "1") return false;
  const r = await run("javap", ["-version"], 10_000);
  return r.code === 0;
}

const NOISE_RE = /access\$\d+\(|lambda\$|\$deserializeLambda\$|\$jacocoInit|-\$\$Nest|\$\$serializer|^\s*static \{\};\s*$/;

/** Split a multi-class javap dump into per-class blocks keyed by fully-qualified class name. */
function splitJavap(out: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let cur: string[] | null = null;
  let curName: string | null = null;
  // Trailing blank lines would otherwise survive slice(1, -1) and leave the block's own
  // closing brace in the member list (producing a duplicated "}" in the output).
  const flush = () => {
    if (!cur || !curName) return;
    while (cur.length && cur[cur.length - 1]!.trim() === "") cur.pop();
    blocks.set(curName, cur);
  };
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^Compiled from /.test(line)) continue;
    const isDecl = line.length > 0 && !/^\s/.test(line) && line.trimEnd().endsWith("{");
    if (isDecl) {
      flush();
      const m = line.match(/(?:class|interface|enum|record|@interface)\s+([\w.$]+)/);
      curName = m ? m[1]! : line.trim();
      cur = [line];
      continue;
    }
    if (cur) cur.push(line);
  }
  flush();
  return blocks;
}

/* ------------------------------------------------- binary AndroidManifest */

interface AxmlResult {
  xml: string;
  source: "axml-decode" | "axml-stringpool-partial";
  note?: string;
}

function decodeStringPool(buf: Buffer, off: number): { strings: string[]; end: number } {
  const chunkSize = buf.readUInt32LE(off + 4);
  const count = buf.readUInt32LE(off + 8);
  const flags = buf.readUInt32LE(off + 16);
  const stringsStart = buf.readUInt32LE(off + 20);
  const utf8 = (flags & (1 << 8)) !== 0;
  const strings: string[] = [];
  const offsetsAt = off + 28;
  for (let i = 0; i < count; i++) {
    const so = off + stringsStart + buf.readUInt32LE(offsetsAt + i * 4);
    if (so >= buf.length) {
      strings.push("");
      continue;
    }
    if (utf8) {
      // u8 char len (possibly 2 bytes), then u8 byte len (possibly 2 bytes), then bytes
      let q = so;
      let n = buf.readUInt8(q++);
      if (n & 0x80) n = ((n & 0x7f) << 8) | buf.readUInt8(q++);
      let bl = buf.readUInt8(q++);
      if (bl & 0x80) bl = ((bl & 0x7f) << 8) | buf.readUInt8(q++);
      strings.push(buf.subarray(q, Math.min(buf.length, q + bl)).toString("utf8"));
    } else {
      let q = so;
      let n = buf.readUInt16LE(q);
      q += 2;
      if (n & 0x8000) {
        n = ((n & 0x7fff) << 16) | buf.readUInt16LE(q);
        q += 2;
      }
      strings.push(buf.subarray(q, Math.min(buf.length, q + n * 2)).toString("utf16le"));
    }
  }
  return { strings, end: off + chunkSize };
}

function decodeAxml(buf: Buffer): AxmlResult {
  const fallback = (note: string): AxmlResult => {
    try {
      // Locate the string pool chunk (immediately after the 8-byte XML header) and dump it.
      const { strings } = decodeStringPool(buf, 8);
      const uniq = strings.filter((s) => s.trim().length > 0);
      return {
        xml: uniq.join("\n"),
        source: "axml-stringpool-partial",
        note: `${note} Falling back to the raw AXML string pool: these are element names, attribute names and string values with NO structure or nesting — do not present them as the manifest contents.`,
      };
    } catch (e: any) {
      throw new ArcError(`AndroidManifest.xml is binary AXML and could not be decoded (${note} ${e?.message ?? e})`);
    }
  };
  try {
    if (buf.length < 8) return fallback("file too small.");
    const type = buf.readUInt16LE(0);
    if (type !== 0x0003) return fallback(`unexpected AXML chunk type 0x${type.toString(16)}.`);
    const pool = decodeStringPool(buf, 8);
    const strings = pool.strings;
    const str = (i: number) => (i >= 0 && i < strings.length ? strings[i]! : `?${i}`);
    let p = pool.end;
    const nsPrefix = new Map<string, string>(); // uri -> prefix
    const out: string[] = [];
    const stack: string[] = [];
    while (p + 8 <= buf.length) {
      const ctype = buf.readUInt16LE(p);
      const csize = buf.readUInt32LE(p + 4);
      if (csize <= 0) break;
      if (ctype === 0x0100) {
        const prefix = str(buf.readInt32LE(p + 16));
        const uri = str(buf.readInt32LE(p + 20));
        nsPrefix.set(uri, prefix);
      } else if (ctype === 0x0102) {
        const name = str(buf.readInt32LE(p + 20));
        // ResXMLTree_attrExt starts at p+16 (after the 8-byte chunk header and the 8-byte
        // ResXMLTree_node), and attributeStart is a byte offset from the START OF THAT STRUCT,
        // not from the chunk start. Getting this wrong shifts every attribute read by 16 bytes
        // and yields plausible-looking garbage (names read out of the previous value slot).
        const attrStart = buf.readUInt16LE(p + 24);
        const attrSize = buf.readUInt16LE(p + 26);
        const attrCount = buf.readUInt16LE(p + 28);
        const attrs: string[] = [];
        for (let i = 0; i < attrCount; i++) {
          const a = p + 16 + attrStart + i * attrSize;
          if (a + 20 > buf.length) break;
          const ns = buf.readInt32LE(a);
          const an = str(buf.readInt32LE(a + 4));
          const rawIdx = buf.readInt32LE(a + 8);
          const dataType = buf.readUInt8(a + 15);
          const data = buf.readInt32LE(a + 16);
          let value: string;
          if (dataType === 0x03) value = rawIdx >= 0 ? str(rawIdx) : str(data);
          else if (dataType === 0x12) value = data === 0 ? "false" : "true";
          else if (dataType === 0x10) value = String(data);
          else if (dataType === 0x01 || dataType === 0x02) value = `@0x${(data >>> 0).toString(16)}`;
          else if (dataType === 0x11) value = `0x${(data >>> 0).toString(16)}`;
          else if (dataType === 0x04) value = String(Buffer.from(new Int32Array([data]).buffer).readFloatLE(0));
          else value = rawIdx >= 0 ? str(rawIdx) : `0x${(data >>> 0).toString(16)}`;
          const prefix = ns >= 0 ? nsPrefix.get(str(ns)) : undefined;
          attrs.push(`${prefix ? `${prefix}:` : ""}${an}="${value}"`);
        }
        out.push(`${"  ".repeat(stack.length)}<${name}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`);
        stack.push(name);
      } else if (ctype === 0x0103) {
        const name = str(buf.readInt32LE(p + 20));
        stack.pop();
        const last = out[out.length - 1];
        if (last && last.trimStart().startsWith(`<${name}`) && last.endsWith(">") && !last.startsWith("</")) {
          out[out.length - 1] = `${last.slice(0, -1)} />`; // collapse empty element to self-closing
        } else {
          out.push(`${"  ".repeat(stack.length)}</${name}>`);
        }
      } else if (ctype === 0x0104) {
        const text = str(buf.readInt32LE(p + 16)).trim();
        if (text) out.push(`${"  ".repeat(stack.length)}${text}`);
      }
      p += csize;
    }
    if (out.length === 0) return fallback("no XML element chunks found.");
    return { xml: out.join("\n"), source: "axml-decode" };
  } catch (e: any) {
    return fallback(`decode error: ${e?.message ?? e}.`);
  }
}

/* ------------------------------------------------------- locate_artifact */

interface Coord {
  coord: string;
  file: string;
  size: number;
  repo: "gradle" | "m2";
}

/**
 * A parsed artifactQuery.
 *
 * "group:name:version" filters each level independently (any part may be empty or globbed).
 * A TWO-part query is genuinely ambiguous — "com.squareup.okhttp3:okhttp" is group:name while
 * "okhttp-eventsource:4.1.1" is name:version — so both interpretations are tried (empirically:
 * assuming group:name alone returned 0 hits for a perfectly reasonable name:version query).
 * A query without ':' is a free-form fragment matched against the WHOLE coordinate, which means
 * it can match on the version too and therefore must NOT be used to prune group/name directories.
 */
interface Alt {
  group?: string;
  name?: string;
  version?: string;
}
interface ParsedQuery {
  free?: string;
  alts: Alt[];
}

function parseArtifactQuery(q: string | undefined): ParsedQuery {
  if (!q || !q.trim()) return { alts: [] };
  const t = q.trim();
  if (!t.includes(":")) return { free: t, alts: [] };
  const parts = t.split(":").map((s) => s.trim());
  const at = (i: number) => (parts[i] ? parts[i] : undefined);
  if (parts.length >= 3) return { alts: [{ group: at(0), name: at(1), version: at(2) }] };
  return { alts: [{ group: at(0), name: at(1) }, { name: at(0), version: at(1) }] };
}

/** undefined filter matches everything; a filter with * or ? is a glob, otherwise a ci substring. */
function partMatch(want: string | undefined, have: string): boolean {
  if (!want) return true;
  return hasWildcard(want) ? globToRegExp(want, true).test(have) : have.toLowerCase().includes(want.toLowerCase());
}

/** True when any exclude term matches the given text (coordinate, group, or "coord filename"). */
function excluded(text: string, excludes: string[]): boolean {
  const lc = text.toLowerCase();
  for (const raw of excludes) {
    const e = raw.trim();
    if (!e) continue;
    if (hasWildcard(e) ? globToRegExp(`*${e}*`, true).test(text) : lc.includes(e.toLowerCase())) return true;
  }
  return false;
}

/** Can this group directory still yield a match? (Used only for safe pruning.) */
function groupPossible(q: ParsedQuery, group: string): boolean {
  if (q.free || q.alts.length === 0) return true;
  return q.alts.some((a) => partMatch(a.group, group));
}

/** Can this group/name directory still yield a match? (Used only for safe pruning.) */
function namePossible(q: ParsedQuery, group: string, name: string): boolean {
  if (q.free || q.alts.length === 0) return true;
  return q.alts.some((a) => partMatch(a.group, group) && partMatch(a.name, name));
}

function coordMatches(coord: string, q: ParsedQuery): boolean {
  const [group = "", name = "", version = ""] = coord.split(":");
  if (q.free) return hasWildcard(q.free) ? globToRegExp(`*${q.free}*`, true).test(coord) : coord.toLowerCase().includes(q.free.toLowerCase());
  if (q.alts.length === 0) return true;
  return q.alts.some((a) => partMatch(a.group, group) && partMatch(a.name, name) && partMatch(a.version, version));
}

const ARTIFACT_RE = /\.(jar|aar|apk)$/i;

async function locateGradle(root: string, q: ParsedQuery, excludes: string[], budget: { dirs: number }): Promise<Coord[]> {
  const out: Coord[] = [];
  let groups: string[] = [];
  try {
    groups = await fs.readdir(root);
  } catch {
    return out;
  }
  for (const group of groups) {
    if (budget.dirs <= 0 || abortSignal?.aborted) break;
    // Safe prunes only: a structured group filter, or an exclude that already matches the group.
    // A free-form query is NOT used to prune here because it may legitimately match the version.
    if (!groupPossible(q, group)) continue;
    if (excluded(group, excludes)) continue;
    let names: string[] = [];
    try {
      names = await fs.readdir(join(root, group));
      budget.dirs--;
    } catch {
      continue;
    }
    for (const name of names) {
      if (!namePossible(q, group, name)) continue;
      let versions: string[] = [];
      try {
        versions = await fs.readdir(join(root, group, name));
        budget.dirs--;
      } catch {
        continue;
      }
      for (const version of versions) {
        const coord = `${group}:${name}:${version}`;
        if (!coordMatches(coord, q) || excluded(coord, excludes)) continue;
        let hashes: string[] = [];
        try {
          hashes = await fs.readdir(join(root, group, name, version));
          budget.dirs--;
        } catch {
          continue;
        }
        for (const h of hashes) {
          let files: string[] = [];
          try {
            files = await fs.readdir(join(root, group, name, version, h));
            budget.dirs--;
          } catch {
            continue;
          }
          for (const f of files) {
            if (!ARTIFACT_RE.test(f)) continue;
            if (excluded(`${coord} ${f}`, excludes)) continue; // lets excludeQuery drop e.g. '-sources'/'-javadoc'
            const p = join(root, group, name, version, h, f);
            try {
              const st = await fs.stat(p);
              out.push({ coord, file: p, size: st.size, repo: "gradle" });
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
  }
  return out;
}

async function locateM2(root: string, q: ParsedQuery, excludes: string[], budget: { dirs: number }): Promise<Coord[]> {
  const out: Coord[] = [];
  const walk = async (dir: string, rel: string[], depth: number): Promise<void> => {
    if (depth > 8 || budget.dirs <= 0) return;
    let ents: any[] = [];
    try {
      ents = await fs.readdir(dir, { withFileTypes: true });
      budget.dirs--;
    } catch {
      return;
    }
    const files = ents.filter((e) => e.isFile() && ARTIFACT_RE.test(e.name));
    if (files.length && rel.length >= 2) {
      const version = rel[rel.length - 1]!;
      const name = rel[rel.length - 2]!;
      const group = rel.slice(0, rel.length - 2).join(".");
      const coord = `${group}:${name}:${version}`;
      if (coordMatches(coord, q) && !excluded(coord, excludes)) {
        for (const f of files) {
          if (excluded(`${coord} ${f.name}`, excludes)) continue;
          const p = join(dir, f.name);
          try {
            const st = await fs.stat(p);
            out.push({ coord, file: p, size: st.size, repo: "m2" });
          } catch {
            /* ignore */
          }
        }
      }
    }
    for (const e of ents) if (e.isDirectory()) await walk(join(dir, e.name), [...rel, e.name], depth + 1);
  };
  await walk(root, [], 0);
  return out;
}

/* ------------------------------------------------------------ parameters */

const actionEnum = ["list", "find_class", "signatures", "extract", "strings", "manifest", "locate_artifact"] as const;

const schema = Type.Object({
  action: Type.Union(
    actionEnum.map((a) => Type.Literal(a)),
    {
      description:
        "list=entries+sizes (replaces `unzip -l`); find_class=locate classes by name, incl. nested jars; " +
        "signatures=javap member dump for matching classes; strings=grep over text entries; " +
        "manifest=MANIFEST.MF / AndroidManifest.xml summary; extract=write entries to destDir (zip-slip safe); " +
        "locate_artifact=find jars/aars in the Gradle/Maven caches by coordinate.",
    },
  ),
  archive: Type.Optional(
    Type.String({
      description:
        "Path to a .jar/.aar/.apk/.zip/.tar(.gz) file. Required for every action except locate_artifact. " +
        "`~` and a single `*` glob segment are resolved (e.g. '~/.gradle/caches/modules-2/files-2.1/g/n/1.0/*/n-1.0.jar').",
    }),
  ),
  classPattern: Type.Optional(
    Type.String({
      description:
        "Class filter for find_class/signatures. Dotted or slashed, wildcards allowed ('*EventSource*', 'com.foo.**'). " +
        "Without a wildcard it is a case-insensitive substring match on the fully-qualified name.",
    }),
  ),
  memberPattern: Type.Optional(
    Type.String({ description: "For signatures: keep only members whose name/signature matches (substring, or glob if it contains * / ?)." }),
  ),
  entryGlob: Type.Optional(
    Type.String({
      description:
        "Entry-path glob for list/strings/extract, unzip-style (`*` crosses '/', so '*.class' matches nested entries). Default: all entries.",
    }),
  ),
  textPattern: Type.Optional(
    Type.String({ description: "For strings: case-insensitive regex to search for inside text entries. Required for action=strings." }),
  ),
  destDir: Type.Optional(
    Type.String({ description: "For extract: destination directory (created if missing). Required — nothing is ever extracted to a temp/implicit location." }),
  ),
  includePrivate: Type.Optional(
    Type.Boolean({ description: "For signatures: also show private/package-private members (javap -p). Default false (public+protected only).", default: false }),
  ),
  artifactQuery: Type.Optional(
    Type.String({
      description:
        "For locate_artifact: 'group:name:version' (any part may be partial/omitted/globbed) or a single fragment matched against the whole coordinate. " +
        "Omit to list the groups present in the caches.",
    }),
  ),
  excludeQuery: Type.Optional(
    Type.String({
      description:
        "For locate_artifact: comma-separated substrings/globs to exclude from results, e.g. 'org.,androidx,com.android' — replaces `ls ~/.gradle/... | grep -viE ...` when hunting for third-party deps.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Max rows/entries/classes returned (list ${DEF_LIST}, find_class ${DEF_FIND}, signatures ${DEF_CLASSES}, strings ${DEF_STRINGS}, locate_artifact ${DEF_LOCATE}).`,
    }),
  ),
});

type Params = Static<typeof schema>;

/* ---------------------------------------------------------------- actions */

interface Out {
  text: string;
  details: Record<string, unknown>;
  isError?: boolean;
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "arcx-"));
  try {
    return await fn(dir);
  } finally {
    // Only ever remove a directory we created under the OS temp dir with our own prefix.
    if (dir.startsWith(tmpdir()) && basename(dir).startsWith("arcx-")) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function dexNote(h: Handle): string | null {
  const dex = h.entries.filter((e) => /^classes\d*\.dex$/.test(e.name) || e.name.endsWith(".dex"));
  if (!dex.length) return null;
  return (
    `This archive contains Dalvik bytecode (${dex.map((d) => d.name).join(", ")}), not .class entries. ` +
    `javap cannot read .dex, so archive_inspect cannot produce signatures for it — use a dex tool ` +
    `(apkanalyzer dex packages / baksmali / jadx) for APK bodies, or inspect the library's .aar/.jar instead.`
  );
}

async function actionList(h: Handle, p: Params): Promise<Out> {
  const limit = Math.max(1, Math.min(p.limit ?? DEF_LIST, 5_000));
  const re = p.entryGlob ? globToRegExp(p.entryGlob) : null;
  const files = h.entries.filter((e) => !e.isDir);
  const dirs = h.entries.length - files.length;
  const matched = re ? files.filter((e) => re.test(e.name)) : files;
  matched.sort((a, b) => a.name.localeCompare(b.name)); // deterministic, diffable order (zip order is arbitrary)
  const shown = matched.slice(0, limit);
  const sized = matched.filter((e) => e.size !== null);
  const totalBytes = sized.reduce((a, e) => a + (e.size ?? 0), 0);
  const head =
    `${h.label}: ${files.length} files, ${dirs} dirs` +
    (re ? `, ${matched.length} match ${p.entryGlob}` : "") +
    (matched.length === 0 ? "" : sized.length === 0 ? ", sizes unavailable" : `, ${human(totalBytes)} uncompressed`) +
    `${matched.some((e) => e.encrypted) ? ", SOME ENTRIES ENCRYPTED" : ""}`;
  const body = shown.map((e) => `${human(e.size).padStart(7)}  ${e.name}${e.encrypted ? "  [encrypted]" : ""}`);
  const more =
    matched.length === 0
      ? [`No entry matches ${p.entryGlob}. Call list without entryGlob to see what is actually in the archive.`]
      : matched.length > shown.length
        ? [`... ${matched.length - shown.length} more entries (raise limit or narrow entryGlob)`]
        : [];
  const warn = h.warnings.map((w) => `warning: ${w}`);
  return {
    text: [head, ...warn, ...body, ...more].join("\n"),
    details: {
      action: "list",
      archiveSource: h.source ?? h.kind,
      entries: files.length,
      matched: matched.length,
      shown: shown.length,
      warnings: h.warnings,
    },
  };
}

async function actionFindClass(h: Handle, p: Params): Promise<Out> {
  const limit = Math.max(1, Math.min(p.limit ?? DEF_FIND, 2_000));
  const { classes, nestedScanned, nestedHandles, notes } = await collectClasses(h, p.classPattern, { scanNested: true });
  for (const nh of nestedHandles.values()) await nh.close();
  const shown = classes.slice(0, limit);
  const lines = shown.map((c) => (c.nested ? `${c.fqn}   [${c.nested}]` : c.fqn));
  const head = `${h.label}: ${classes.length} classes match ${p.classPattern ?? "(all)"}${
    nestedScanned.length ? ` (scanned nested jars: ${nestedScanned.join(", ")})` : ""
  }`;
  const extra: string[] = [];
  if (classes.length === 0) {
    const dn = dexNote(h);
    if (dn) extra.push(dn);
    else {
      const all = h.entries.filter((e) => e.name.endsWith(".class"));
      if (all.length === 0) extra.push("This archive contains no .class entries at all.");
      else {
        const pkgs = [...new Set(all.map((e) => entryToFqn(e.name).split(".").slice(0, 3).join(".")))].slice(0, 15);
        extra.push(`No class matched. ${all.length} classes exist; top packages: ${pkgs.join(", ")}`);
      }
    }
  }
  if (classes.length > shown.length) extra.push(`... ${classes.length - shown.length} more (raise limit or narrow classPattern)`);
  return {
    text: [head, ...notes.map((n) => `note: ${n}`), ...h.warnings.map((w) => `warning: ${w}`), ...lines, ...extra].join("\n"),
    details: { action: "find_class", archiveSource: h.source ?? h.kind, matched: classes.length, shown: shown.length, nestedScanned },
  };
}

async function actionSignatures(h: Handle, archivePath: string, p: Params): Promise<Out> {
  const limit = Math.max(1, Math.min(p.limit ?? DEF_CLASSES, 60));
  const { classes, nestedScanned, nestedHandles, notes } = await collectClasses(h, p.classPattern, { scanNested: true });
  try {
    if (classes.length === 0) {
      const dn = dexNote(h);
      const all = h.entries.filter((e) => e.name.endsWith(".class")).length;
      const hint = dn
        ? dn
        : all === 0
          ? "This archive contains no .class entries at all."
          : `${all} classes exist in the archive but none matched. Run action=find_class with a looser classPattern first.`;
      return {
        text: `${h.label}: no class matched ${p.classPattern ?? "(all)"}.\n${hint}`,
        details: { action: "signatures", matched: 0 },
        isError: true,
      };
    }
    const picked = classes.slice(0, limit);
    const useJavap = await javapAvailable();

    // javap pass (best effort) — its output is split per class so any class it could not
    // resolve can fall back individually instead of dragging the whole batch into the
    // degraded path. Provenance is then tagged per block, not per call.
    let javapBlocks = new Map<string, string[]>();
    if (useJavap) {
      const result = await withTemp(async (tmp) => {
        const cp: string[] = [];
        const direct = picked.filter((c) => !c.nested);
        const nestedJars = [...new Set(picked.filter((c) => c.nested).map((c) => c.nested!))];

        if (direct.length && h.kind === "zip") cp.push(archivePath);
        if (direct.length && h.kind !== "zip") {
          // tar (or any non-zip): materialize the class files at their package paths
          for (const c of direct) {
            const buf = await h.read(c.entry);
            const dest = join(tmp, `${c.fqn.replace(/\./g, "/")}.class`);
            await fs.mkdir(dirname(dest), { recursive: true });
            await fs.writeFile(dest, buf);
          }
          cp.push(tmp);
        }
        for (const jarName of nestedJars) {
          const buf = await h.read(jarName);
          const dest = join(tmp, `${nestedJars.indexOf(jarName)}-${basename(jarName)}`);
          await fs.writeFile(dest, buf);
          cp.push(dest);
        }
        const flag = p.includePrivate ? "-p" : "-protected";
        let r = await run("javap", [flag, "-classpath", cp.join(":"), ...picked.map((c) => c.fqn)]);
        if (!r.stdout.trim() && direct.length && h.kind === "zip") {
          // Odd layout (entry path does not match the package declared in the class file):
          // extract those entries at their true package paths and retry.
          for (const c of direct) {
            const buf = await h.read(c.entry);
            const dest = join(tmp, `${c.fqn.replace(/\./g, "/")}.class`);
            await fs.mkdir(dirname(dest), { recursive: true });
            await fs.writeFile(dest, buf);
          }
          r = await run("javap", [flag, "-classpath", [tmp, ...cp].join(":"), ...picked.map((c) => c.fqn)]);
        }
        return r;
      });
      javapBlocks = splitJavap(result.stdout);
      if (javapBlocks.size === 0)
        notes.push(
          `javap produced no usable output (${(result.stderr || `exit ${result.code}`).trim().slice(0, 200)}); using in-process class file parsing instead`,
        );
      else if (result.stderr.trim() && javapBlocks.size < picked.length) notes.push(`javap stderr: ${result.stderr.trim().slice(0, 300)}`);
    } else {
      notes.push(
        process.env.ARCX_DISABLE_JAVAP === "1"
          ? "javap disabled via ARCX_DISABLE_JAVAP=1"
          : "javap/JDK not found on PATH (install a JDK for generics, throws clauses and annotations)",
      );
    }

    const memberOk = (line: string): boolean => {
      if (!p.memberPattern) return true;
      return hasWildcard(p.memberPattern)
        ? globToRegExp(`*${p.memberPattern}*`, true).test(line)
        : line.toLowerCase().includes(p.memberPattern.toLowerCase());
    };
    const capMembers = (body: string[]): string[] =>
      body.length > MAX_MEMBERS_PER_CLASS
        ? [...body.slice(0, MAX_MEMBERS_PER_CLASS), `  ... ${body.length - MAX_MEMBERS_PER_CLASS} more members (narrow with memberPattern)`]
        : body;

    const blocks: string[] = [];
    let nJavap = 0;
    let nParse = 0;
    for (const c of picked) {
      const jb = javapBlocks.get(c.fqn) ?? javapBlocks.get(c.fqn.replace(/\$/g, ".")) ?? null;
      if (jb) {
        nJavap++;
        const body = capMembers(
          jb
            .slice(1, -1)
            .map((l) => l.replace(/\s+$/, ""))
            .filter((l) => l.trim().length > 0 && !NOISE_RE.test(l))
            .filter(memberOk),
        );
        blocks.push([`${c.fqn}${c.nested ? `   [${c.nested}]` : ""}   source: javap`, jb[0]!, ...body, "}"].join("\n"));
        continue;
      }
      // Per-class degraded path: read the bytes and parse the class file ourselves.
      try {
        const srcH = c.nested ? nestedHandles.get(c.nested)! : h;
        const buf = await srcH.read(c.entry);
        const pc = parseClassFile(buf);
        nParse++;
        const label = pc.thisClass !== c.fqn ? `${pc.thisClass} (entry ${c.entry})` : c.fqn;
        blocks.push(
          [`${label}${c.nested ? `   [${c.nested}]` : ""}   source: classfile-parse`, ...renderParsedClass(pc, !!p.includePrivate, p.memberPattern)].join("\n"),
        );
      } catch (e: any) {
        blocks.push(`${c.fqn}: could not read/parse class file (${e?.message ?? e})   source: none`);
      }
    }

    const source = nParse === 0 ? "javap" : nJavap === 0 ? "classfile-parse" : "mixed";
    const sourceTag =
      source === "javap"
        ? "source: javap for every class below (exact — generics, throws clauses and annotations included)"
        : source === "classfile-parse"
          ? "source: classfile-parse for every class below (FALLBACK: erased types only — NO generics, NO throws clauses, NO annotations; do not present these as the library's declared generic API)"
          : `sources: javap for ${nJavap} class(es), classfile-parse for ${nParse} (each block is tagged; classfile-parse blocks have erased types — no generics/throws/annotations)`;
    const head =
      `${h.label}: signatures for ${blocks.length}/${classes.length} matching classes` +
      `${p.includePrivate ? " (incl. private)" : " (public+protected)"}${nestedScanned.length ? `, nested jars: ${nestedScanned.join(", ")}` : ""}`;
    const tail = classes.length > picked.length ? [`... ${classes.length - picked.length} more matching classes not dumped (raise limit or narrow classPattern)`] : [];
    return {
      text: [head, sourceTag, ...h.warnings.map((w) => `warning: ${w}`), ...notes.map((n) => `note: ${n}`), "", ...blocks, ...tail].join("\n"),
      details: { action: "signatures", source, archiveSource: h.source ?? h.kind, javapClasses: nJavap, fallbackClasses: nParse, matched: classes.length, dumped: blocks.length },
    };
  } finally {
    for (const nh of nestedHandles.values()) await nh.close();
  }
}

const TEXT_EXT_RE = /\.(txt|xml|json|properties|mf|md|pro|cfg|conf|ini|yml|yaml|kotlin_module|version|sf|rsa|dsa|list|csv|html|js|css|proto|sql|graphql|ts|java|kt|scala|groovy|gradle|py|sh|toml|dat|api)$/i;

async function actionStrings(h: Handle, p: Params): Promise<Out> {
  if (!p.textPattern) return { text: "Error: action=strings needs 'textPattern' (a case-insensitive regex).", details: { action: "strings" }, isError: true };
  let re: RegExp;
  try {
    re = new RegExp(p.textPattern, "i");
  } catch (e: any) {
    return { text: `Error: invalid textPattern regex: ${e?.message ?? e}`, details: { action: "strings" }, isError: true };
  }
  const limit = Math.max(1, Math.min(p.limit ?? DEF_STRINGS, 2_000));
  const globRe = p.entryGlob ? globToRegExp(p.entryGlob) : null;
  const cands = h.entries.filter((e) => !e.isDir && (globRe ? globRe.test(e.name) : !e.name.endsWith(".class")));
  const hits: string[] = [];
  let scanned = 0;
  let bytes = 0;
  let binary = 0;
  let failed = 0;
  const notes: string[] = [];
  for (const e of cands) {
    if (hits.length >= limit || scanned >= MAX_STRINGS_SCAN_ENTRIES || bytes >= MAX_STRINGS_SCAN_BYTES || abortSignal?.aborted) break;
    if ((e.size ?? 0) > 8 * 1024 * 1024 && !TEXT_EXT_RE.test(e.name)) continue;
    scanned++;
    let buf: Buffer;
    try {
      buf = await h.read(e.name);
    } catch (err: any) {
      failed++;
      if (failed <= 3) notes.push(`could not read '${e.name}': ${err?.message ?? err}`);
      continue;
    }
    bytes += buf.length;
    const probe = buf.subarray(0, Math.min(buf.length, 8192));
    if (probe.includes(0)) {
      binary++;
      continue;
    }
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i]!)) continue;
      const line = lines[i]!.replace(/\r$/, "").trim();
      hits.push(`${e.name}:${i + 1}: ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`);
      if (hits.length >= limit) break;
    }
  }
  const head = `${h.label}: ${hits.length} matching lines for /${p.textPattern}/i in ${scanned} text entries (skipped ${binary} binary${
    cands.length > scanned ? `, ${cands.length - scanned} entries not scanned due to caps` : ""
  })`;
  return {
    text: [head, ...h.warnings.map((w) => `warning: ${w}`), ...notes.map((n) => `note: ${n}`), ...hits, ...(hits.length >= limit ? ["... more matches exist (raise limit or narrow entryGlob)"] : [])].join("\n"),
    details: { action: "strings", hits: hits.length, scanned, binarySkipped: binary },
  };
}

async function actionManifest(h: Handle, p: Params): Promise<Out> {
  const parts: string[] = [];
  const details: Record<string, unknown> = { action: "manifest" };
  const jarMf = h.entries.find((e) => e.name.toUpperCase() === "META-INF/MANIFEST.MF");
  const androidMf = h.entries.find((e) => e.name === "AndroidManifest.xml");
  if (!jarMf && !androidMf)
    return {
      text: `${h.label}: no META-INF/MANIFEST.MF and no AndroidManifest.xml entry found. (Entries present: ${h.entries.length}; use action=list to see them.)`,
      details,
      isError: true,
    };

  if (jarMf) {
    try {
      const text = (await h.read(jarMf.name)).toString("utf8").replace(/\r\n/g, "\n").trim();
      parts.push(`=== META-INF/MANIFEST.MF (${human(jarMf.size)}) ===`, text.length > 4000 ? `${text.slice(0, 4000)}\n... [manifest truncated]` : text);
      details.jarManifest = true;
    } catch (e: any) {
      parts.push(`=== META-INF/MANIFEST.MF ===`, `could not read: ${e?.message ?? e}`);
    }
  }
  if (androidMf) {
    try {
      const buf = await h.read(androidMf.name);
      const isText = buf.subarray(0, 5).toString("utf8").trimStart().startsWith("<");
      if (isText) {
        const text = buf.toString("utf8");
        parts.push(`=== AndroidManifest.xml (${human(androidMf.size)}, plain text) ===`, "source: plain-text XML (exact)", text.length > 8000 ? `${text.slice(0, 8000)}\n... [truncated]` : text);
        details.androidManifestSource = "text";
      } else {
        const dec = decodeAxml(buf);
        const summary: string[] = [];
        const pkg = dec.xml.match(/<manifest[^>]*\bpackage="([^"]+)"/);
        if (pkg) summary.push(`package: ${pkg[1]}`);
        const perms = [...dec.xml.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map((m) => m[1]);
        if (perms.length) summary.push(`uses-permission: ${perms.join(", ")}`);
        const sdk = dec.xml.match(/<uses-sdk([^>]*)>/);
        if (sdk) summary.push(`uses-sdk:${sdk[1]!.replace(/\s*\/\s*$/, "")}`);
        const comps = [...dec.xml.matchAll(/<(activity|service|receiver|provider)[^>]*android:name="([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
        if (comps.length) summary.push(`components (${comps.length}): ${comps.slice(0, 25).join("; ")}${comps.length > 25 ? " …" : ""}`);
        parts.push(
          `=== AndroidManifest.xml (${human(androidMf.size)}, BINARY AXML) ===`,
          `source: ${dec.source}${dec.source === "axml-decode" ? " (decoded in-process from binary AXML; resource references appear as @0x… ids, not resolved names)" : ""}`,
          ...(dec.note ? [`note: ${dec.note}`] : []),
          ...(summary.length ? ["--- summary ---", ...summary] : []),
          "--- xml ---",
          dec.xml.length > 12_000 ? `${dec.xml.slice(0, 12_000)}\n... [truncated]` : dec.xml,
        );
        details.androidManifestSource = dec.source;
      }
    } catch (e: any) {
      parts.push(`=== AndroidManifest.xml ===`, `Error: ${e?.message ?? e}`);
      details.androidManifestSource = "error";
    }
  }
  return { text: [h.label, ...h.warnings.map((w) => `warning: ${w}`), ...parts].join("\n"), details: { ...details, archiveSource: h.source ?? h.kind } };
}

function unsafeEntry(name: string): string | null {
  if (name.startsWith("/") || name.startsWith("\\")) return "absolute path";
  if (/^[a-zA-Z]:[\\/]/.test(name)) return "absolute Windows path";
  const segs = name.split(/[\\/]/);
  if (segs.includes("..")) return "'..' path traversal";
  return null;
}

async function actionExtract(h: Handle, archivePath: string, p: Params): Promise<Out> {
  if (!p.destDir) return { text: "Error: action=extract requires 'destDir' (archive_inspect never picks an implicit destination).", details: { action: "extract" }, isError: true };
  const dest = resolve(expandHome(p.destDir));
  // Hard refusal: the dependency caches are read-only territory. (Extracting into a
  // SUBDIRECTORY of the archive's own directory is legitimate — the classic
  // `cd /tmp/scan && unzip x.jar -d cls` idiom — so only the archive's exact directory
  // is refused, to avoid mixing extracted files in with the archive itself.)
  for (const cache of [join(homedir(), ".gradle"), join(homedir(), ".m2")]) {
    if (dest === cache || dest.startsWith(cache + sep))
      return {
        text: `Error: refusing to extract into '${dest}' because it is inside the dependency cache '${cache}' (archive_inspect never writes into ~/.gradle or ~/.m2). Pass a scratch destDir such as /tmp/... instead.`,
        details: { action: "extract", refusedDest: dest },
        isError: true,
      };
  }
  if (dest === dirname(resolve(archivePath)))
    return {
      text: `Error: refusing to extract into '${dest}' because that is the archive's own directory. Pass a subdirectory (e.g. '${join(dest, "extracted")}') or another scratch directory.`,
      details: { action: "extract", refusedDest: dest },
      isError: true,
    };
  const limit = Math.max(1, Math.min(p.limit ?? 2_000, 20_000));
  const re = p.entryGlob ? globToRegExp(p.entryGlob) : null;
  const cands = h.entries.filter((e) => !e.isDir && (re ? re.test(e.name) : true));

  const refused: string[] = [];
  const safe: AEntry[] = [];
  for (const e of cands) {
    const bad = unsafeEntry(e.name);
    if (bad) {
      refused.push(`${e.name}  [${bad}]`);
      continue;
    }
    const target = resolve(dest, e.name);
    if (target !== dest && !target.startsWith(dest + sep)) {
      refused.push(`${e.name}  [resolves outside destDir]`);
      continue;
    }
    safe.push(e);
  }

  await fs.mkdir(dest, { recursive: true });
  const written: string[] = [];
  const errors: string[] = [];
  let bytes = 0;
  for (const e of safe.slice(0, limit)) {
    if (bytes >= MAX_EXTRACT_BYTES) {
      errors.push(`stopped after ${human(bytes)} extracted (cap ${human(MAX_EXTRACT_BYTES)})`);
      break;
    }
    try {
      const buf = await h.read(e.name);
      const target = resolve(dest, e.name);
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.writeFile(target, buf);
      bytes += buf.length;
      written.push(e.name);
    } catch (err: any) {
      errors.push(`${e.name}: ${err?.message ?? err}`);
    }
  }

  const head = `${h.label} -> ${dest}: wrote ${written.length} files (${human(bytes)}), refused ${refused.length} unsafe entries${
    safe.length > limit ? `, ${safe.length - limit} over limit not written` : ""
  }`;
  const lines = [
    head,
    ...(refused.length ? ["REFUSED (zip-slip protection — these entries were NOT written):", ...refused.slice(0, 50).map((r) => `  ${r}`)] : []),
    ...(refused.length > 50 ? [`  ... ${refused.length - 50} more refused`] : []),
    ...(errors.length ? ["errors:", ...errors.slice(0, 20).map((e) => `  ${e}`)] : []),
    ...written.slice(0, 100).map((w) => `  ${w}`),
    ...(written.length > 100 ? [`  ... ${written.length - 100} more written`] : []),
  ];
  return {
    text: lines.join("\n"),
    details: { action: "extract", written: written.length, refused: refused.length, bytes, dest },
    isError: refused.length > 0 && written.length === 0,
  };
}

async function actionLocate(p: Params): Promise<Out> {
  const limit = Math.max(1, Math.min(p.limit ?? DEF_LOCATE, 500));
  const gradleRoot = join(homedir(), ".gradle", "caches", "modules-2", "files-2.1");
  const m2Root = join(homedir(), ".m2", "repository");
  const excludes = (p.excludeQuery ?? "").split(",").filter((s) => s.trim().length > 0);
  const budget = { dirs: MAX_LOCATE_DIRS };

  if (!p.artifactQuery) {
    // Group listing mode — replaces `ls ~/.gradle/caches/modules-2/files-2.1 | grep -viE ...`
    const out: string[] = [];
    let groups: string[] = [];
    try {
      groups = (await fs.readdir(gradleRoot)).sort();
    } catch {
      /* ignore */
    }
    const kept = groups.filter((g) => !excluded(g, excludes));
    out.push(`gradle cache ${gradleRoot}: ${groups.length} groups${excludes.length ? `, ${kept.length} after excluding ${excludes.join(",")}` : ""}`);
    out.push(...kept.slice(0, limit));
    if (kept.length > limit) out.push(`... ${kept.length - limit} more groups (raise limit, or pass artifactQuery)`);
    if (existsSync(m2Root)) out.push(`(a local Maven repository also exists at ${m2Root}; pass artifactQuery to search both)`);
    return { text: out.join("\n"), details: { action: "locate_artifact", mode: "groups", groups: groups.length, shown: Math.min(kept.length, limit) } };
  }

  const q = parseArtifactQuery(p.artifactQuery);
  const found: Coord[] = [];
  if (existsSync(gradleRoot)) found.push(...(await locateGradle(gradleRoot, q, excludes, budget)));
  if (existsSync(m2Root)) found.push(...(await locateM2(m2Root, q, excludes, budget)));

  // main artifact first, then sources/javadoc; newest-looking versions first within a coordinate
  const rank = (f: string) => (/-sources\.|-javadoc\./.test(f) ? 1 : 0);
  found.sort((a, b) => a.coord.localeCompare(b.coord) || rank(a.file) - rank(b.file) || a.file.localeCompare(b.file));
  const shown = found.slice(0, limit);
  const head = `${found.length} artifacts match '${p.artifactQuery}'${excludes.length ? ` excluding ${excludes.join(",")}` : ""}${
    budget.dirs <= 0 ? " (WARNING: directory walk budget exhausted, results may be incomplete)" : ""
  }`;
  const lines = shown.map((c) => `${c.coord}  ${human(c.size).padStart(7)}  ${c.file}`);
  const tail: string[] = [];
  if (found.length > shown.length) tail.push(`... ${found.length - shown.length} more (raise limit or narrow artifactQuery)`);
  if (found.length === 0)
    tail.push(
      `No artifact matched. Try a shorter fragment (e.g. just the artifact name), or call locate_artifact with no artifactQuery to see which groups exist.`,
    );
  return { text: [head, ...lines, ...tail].join("\n"), details: { action: "locate_artifact", matched: found.length, shown: shown.length } };
}

/* ----------------------------------------------------------- registration */

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "archive_inspect",
    label: "Archive Inspect",
    description: `Inspect JVM/Android artifacts (.jar/.aar/.apk/.zip/.tar) and the Gradle/Maven caches without shelling out to unzip/tar/jar/javap and without leaving temp files behind.

Actions:
  locate_artifact - find a dependency's jar/aar in ~/.gradle/caches/modules-2/files-2.1 and ~/.m2/repository by coordinate (artifactQuery "group:name:version", parts optional/globbable; excludeQuery drops noise like "org.,androidx"). Omit artifactQuery to list groups.
  list            - entries + uncompressed sizes, name-sorted, filtered by entryGlob (replaces \`unzip -l\`). The header already reports the total match count, so to COUNT entries pass limit:1 instead of listing them all.
  find_class      - locate classes by name pattern, descending into nested jars of an .aar (classes.jar, libs/*.jar). Anonymous/synthetic inner classes (Foo$1, Foo$$Lambda$2) are hidden unless classPattern contains '$'.
  signatures      - javap dump of public+protected members (includePrivate for -p) for classes matching classPattern, synthetic/lambda noise removed. Each class block is tagged "source: javap" (exact) or "source: classfile-parse" (fallback when javap cannot resolve it: erased types, no generics/throws).
  strings         - case-insensitive regex search over the archive's text entries (textPattern).
  manifest        - META-INF/MANIFEST.MF and/or AndroidManifest.xml. Binary AXML is decoded in-process and tagged "source: axml-decode"; if that fails it degrades to "source: axml-stringpool-partial" (unstructured strings) — never silently fabricated.
  extract         - write entries into an explicit destDir only; entries with absolute paths or ".." are REFUSED and listed (zip-slip protection). Refuses a destDir inside ~/.gradle or ~/.m2.

Typical investigation of an unknown dependency (3 calls, no /tmp litter):
  {"action":"locate_artifact","artifactQuery":"launchdarkly:okhttp-eventsource"}
  {"action":"find_class","archive":"/path/okhttp-eventsource-4.1.1.jar","classPattern":"*EventSource*"}
  {"action":"signatures","archive":"/path/okhttp-eventsource-4.1.1.jar","classPattern":"com.launchdarkly.eventsource.EventSource"}

archive accepts ~ and one glob segment, so the gradle cache hash directory can be written as
  "~/.gradle/caches/modules-2/files-2.1/com.launchdarkly/okhttp-eventsource/4.1.1/*/okhttp-eventsource-4.1.1.jar".
APKs contain classes.dex, not .class: signatures/find_class report that honestly instead of guessing.
Encrypted (password-protected) entries are listed but never decrypted. If an archive's central directory is unreadable (truncated download), entries are recovered by scanning local file headers and every result carries a "source: local-header-scan" warning meaning the listing may be incomplete.`,
    promptSnippet: "Inspect jar/aar/apk/zip/tar contents, dump class signatures via javap, and locate dependency artifacts in the Gradle/Maven caches",
    promptGuidelines: [
      "Use archive_inspect instead of bash unzip/tar/jar/javap pipelines when investigating what a third-party JVM/Android dependency contains or exposes — it needs no temp directory, no `mkdir -p /tmp/...`, and caps its own output.",
      "To COUNT entries or classes with archive_inspect, call action=list or action=find_class with limit:1 and read the count in the header line — do not list hundreds of entries just to count them.",
      "archive_inspect hides anonymous inner classes (Foo$1, Foo$$Lambda$2) from find_class/signatures and reports how many it hid; add '$' to classPattern only when you specifically need them.",
      "Use archive_inspect action=locate_artifact to find a dependency jar/aar in ~/.gradle/caches/modules-2/files-2.1 or ~/.m2 instead of `ls`/`find` + `grep` over the cache; pass excludeQuery like 'org.,androidx,com.android' to filter out first-party/AndroidX noise.",
      "For an unknown dependency, chain archive_inspect calls: locate_artifact -> find_class (with a loose classPattern) -> signatures (with the exact class). Do not call signatures with a wildcard that matches hundreds of classes; it caps at a few classes per call by design.",
      "Trust archive_inspect signatures blocks tagged 'source: javap' as exact. A block tagged 'source: classfile-parse' has erased types (no generics/throws/annotations) — say so rather than presenting it as the library's declared API; a block tagged 'source: none' means the class could not be read at all.",
      "Trust archive_inspect manifest output tagged 'source: axml-decode' or 'source: plain-text XML'; if it is tagged 'source: axml-stringpool-partial', the output is an unordered string dump with no structure — do not present it as the manifest's contents.",
      "Use archive_inspect action=extract only when files must really land on disk, and always pass an explicit scratch destDir; it refuses '..'/absolute entries and destDirs inside ~/.gradle or ~/.m2 and lists what it refused.",
      "When archive_inspect reports that an archive contains classes.dex (an APK), do not retry with a different classPattern — .class signatures do not exist there; use a dex tool via bash instead.",
      "If an archive_inspect result carries a 'source: local-header-scan' warning, the archive is damaged/truncated: the entry list is best-effort and may be missing entries, so say so instead of reporting it as the archive's full contents. Results without that warning came from the central directory and are complete.",
    ],
    parameters: schema,
    async execute(_toolCallId, params: Params, signal, onUpdate, _ctx) {
      abortSignal = signal ?? undefined;
      const fin = (o: Out) => ({
        content: [{ type: "text" as const, text: truncateText(o.text, "Narrow the pattern/glob or lower 'limit'.") }],
        details: { archive: params.archive, ...o.details },
        isError: !!o.isError,
      });
      const bad = (msg: string) => fin({ text: `Error: ${msg}`, details: { action: params.action }, isError: true });

      try {
        if (params.action === "locate_artifact") {
          onUpdate?.({ content: [{ type: "text", text: "Scanning dependency caches..." }], details: { action: "locate_artifact" } });
          return fin(await actionLocate(params));
        }
        if (!params.archive) return bad(`action=${params.action} requires 'archive' (path to a .jar/.aar/.apk/.zip/.tar file).`);

        const path = await resolveArchivePath(params.archive);
        onUpdate?.({ content: [{ type: "text", text: `Reading ${basename(path)}...` }], details: { action: params.action } });
        const h = await openArchive(path);
        try {
          switch (params.action) {
            case "list":
              return fin(await actionList(h, params));
            case "find_class":
              return fin(await actionFindClass(h, params));
            case "signatures":
              return fin(await actionSignatures(h, path, params));
            case "strings":
              return fin(await actionStrings(h, params));
            case "manifest":
              return fin(await actionManifest(h, params));
            case "extract":
              return fin(await actionExtract(h, path, params));
            default:
              return bad(`unknown action '${(params as any).action}'. Valid: ${actionEnum.join(", ")}`);
          }
        } finally {
          await h.close();
        }
      } catch (e: any) {
        if (e instanceof ArcError) return bad(e.message);
        return bad(`${e?.message ?? String(e)}`);
      }
    },
    renderCall(args: Params, theme) {
      const bits = [
        args.archive && basename(args.archive),
        args.artifactQuery,
        args.classPattern,
        args.textPattern && `/${args.textPattern}/`,
        args.entryGlob,
        args.destDir && `-> ${args.destDir}`,
      ].filter(Boolean) as string[];
      return new Text(
        `${theme.fg("accent", "archive_inspect")} ${theme.bold(args.action)}${bits.length ? ` ${theme.fg("dim", bits.join(" "))}` : ""}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Inspecting archive..."), 0, 0);
      const first = result.content[0];
      const text = (first && "text" in first ? first.text : "") ?? "";
      if (text.startsWith("Error:")) return new Text(theme.fg("error", text.split("\n").slice(0, 6).join("\n")), 0, 0);
      const lines = text.split("\n");
      if (!expanded && lines.length > 15) return new Text(`${lines.slice(0, 15).join("\n")}\n... and ${lines.length - 15} more lines`, 0, 0);
      return new Text(text, 0, 0);
    },
  });
}
