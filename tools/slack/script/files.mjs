/** Local file helpers: save downloads without overwriting, describe them, read files for upload. */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { fmtSize } from "./format.mjs";

export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

const TEXT_EXT = new Set([
  ".txt", ".md", ".json", ".csv", ".tsv", ".log", ".xml", ".yml", ".yaml", ".html", ".htm", ".js", ".ts",
  ".tsx", ".jsx", ".kt", ".java", ".py", ".sh", ".sql", ".gradle", ".properties", ".toml", ".ini", ".diff", ".patch",
]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export const expandPath = (p) => resolve(p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

export function safeName(name) {
  const n = basename(name || "file").replace(/[^\w.\-+ ()]/g, "_").trim();
  return n || "file";
}

/** Save bytes to `dir` (default: <tmp>/slack-cli-files) without overwriting; returns the absolute path. */
export function saveBuffer(buf, name, saveTo) {
  const dir = saveTo ? expandPath(saveTo) : join(tmpdir(), "slack-cli-files");
  mkdirSync(dir, { recursive: true });
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let target = join(dir, name);
  for (let i = 1; i < 1000; i++) {
    try {
      statSync(target);
      target = join(dir, `${stem}-${i}${ext}`);
    } catch {
      break;
    }
  }
  writeFileSync(target, buf);
  return target;
}

export function fileKind(name, mime) {
  const ext = extname(name).toLowerCase();
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/") || IMAGE_EXT.has(ext)) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf" || ext === ".pdf") return "pdf";
  if (m.startsWith("text/") || TEXT_EXT.has(ext) || m === "application/json") return "text";
  return "binary";
}

/** Describe a saved file with a hint on how to look inside it. */
export function describeFile(path, name, mime, size) {
  const kind = fileKind(name, mime);
  const head = `Saved: ${path}\nName: ${name}  Type: ${mime || "?"}  Size: ${fmtSize(size)}`;
  const hint = {
    image: "(image: open it with the Read tool to view it)",
    text: "(text: open it with the Read tool)",
    pdf: `(pdf: the Read tool can open it, or extract text with \`pdftotext -layout "${path}" -\`)`,
    video: `(video: not viewable directly. Extract frames, e.g. \`ffmpeg -i "${path}" -vf fps=1 /tmp/frames_%03d.png\`, then Read the images.)`,
    audio: "(audio: not readable directly; transcribe with a local tool if available.)",
    binary: "(binary/document file: inspect with bash, e.g. `unzip -l` for docx/xlsx/zip, `file`.)",
  }[kind];
  return { kind, text: `${head}\n${hint}` };
}

/** Read a local file for upload with sanity checks. Returns { error } on failure. */
export function readForUpload(p) {
  const path = expandPath(p);
  let st;
  try {
    st = statSync(path);
  } catch {
    return { error: `File not found: ${path}` };
  }
  if (!st.isFile()) return { error: `Not a regular file: ${path}` };
  if (st.size === 0) return { error: `File is empty: ${path}` };
  if (st.size > MAX_UPLOAD_BYTES) return { error: `File too large (${fmtSize(st.size)}): ${path}` };
  return { path, buf: readFileSync(path), name: basename(path) };
}
