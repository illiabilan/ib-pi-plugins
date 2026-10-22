/**
 * File helpers shared (copied) by the slack and jira extensions:
 * save downloads to disk and turn them into tool-result content the model can read.
 */
import { mkdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_INLINE_TEXT_BYTES = 60 * 1024;

const TEXT_EXT = new Set([
  ".txt", ".md", ".json", ".csv", ".tsv", ".log", ".xml", ".yml", ".yaml", ".html", ".htm", ".js", ".ts",
  ".tsx", ".jsx", ".kt", ".java", ".py", ".sh", ".sql", ".gradle", ".properties", ".toml", ".ini", ".diff", ".patch",
]);
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

export const expandPath = (p: string): string => resolve(p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

export function safeName(name: string): string {
  const n = basename(name || "file").replace(/[^\w.\-+ ()]/g, "_").trim();
  return n || "file";
}

/** Save bytes to `dir` (default: tmp/<sub>) without overwriting; returns the absolute path. */
export function saveBuffer(buf: Buffer, name: string, sub: string, saveTo?: string): string {
  const dir = saveTo ? expandPath(saveTo) : join(tmpdir(), sub);
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

export const fmtSize = (n?: number): string =>
  n === undefined || !Number.isFinite(n) ? "?" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Describe a saved file and inline what the model can read directly (images, small text). */
export function describeFile(path: string, name: string, mime: string | undefined, size: number): Block[] {
  const ext = extname(name).toLowerCase();
  const m = (mime ?? "").toLowerCase();
  const blocks: Block[] = [];
  const kind = m.startsWith("image/") || IMAGE_MIME[ext] ? "image" : m.startsWith("video/") ? "video" : m.startsWith("audio/") ? "audio" : m === "application/pdf" || ext === ".pdf" ? "pdf" : m.startsWith("text/") || TEXT_EXT.has(ext) || m === "application/json" ? "text" : "binary";
  let head = `Saved: ${path}\nName: ${name}  Type: ${mime || "?"}  Size: ${fmtSize(size)}`;
  if (kind === "image") {
    const imgMime = IMAGE_MIME[ext] ?? (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(m) ? m : undefined);
    if (imgMime && size <= MAX_INLINE_IMAGE_BYTES) {
      blocks.push({ type: "image", data: readFileSync(path).toString("base64"), mimeType: imgMime });
    } else {
      head += `\n(image not inlined: ${imgMime ? "larger than 4 MB" : "format unsupported for inline view"}; convert/resize it with bash, e.g. sips or magick)`;
    }
  } else if (kind === "text") {
    const buf = readFileSync(path);
    const slice = buf.subarray(0, MAX_INLINE_TEXT_BYTES).toString("utf8");
    head += `\n\n--- content${buf.length > MAX_INLINE_TEXT_BYTES ? ` (first ${fmtSize(MAX_INLINE_TEXT_BYTES)} of ${fmtSize(size)}; read the file for the rest)` : ""} ---\n${slice}`;
  } else if (kind === "video") {
    head += `\n(video: not viewable directly. Extract frames with bash, e.g. \`ffmpeg -i "${path}" -vf fps=1 /tmp/frames_%03d.png\`, then read the images.)`;
  } else if (kind === "audio") {
    head += `\n(audio: not readable directly; transcribe with a local tool if available.)`;
  } else if (kind === "pdf") {
    head += `\n(pdf: extract text with bash, e.g. \`pdftotext -layout "${path}" -\`, or render pages with \`pdftoppm -png\`.)`;
  } else {
    head += `\n(binary/document file: inspect with bash, e.g. \`unzip -l\` for docx/xlsx/zip, \`file\`.)`;
  }
  return [{ type: "text", text: head }, ...blocks];
}

/** Read a local file for upload with sanity checks. */
export function readForUpload(p: string): { path: string; buf: Buffer; name: string } | { error: string } {
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
