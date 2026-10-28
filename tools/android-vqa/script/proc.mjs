import { spawn } from "node:child_process";

/** Error with a `code`: "usage" maps to exit 2, anything else to exit 1. */
export class VqaError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.code = code;
  }
}
export const usageErr = (m) => new VqaError(m, { code: "usage" });
export const errText = (e) => (e instanceof Error ? e.message : String(e));

/** Run a command, capture stdout/stderr as text. Never rejects; spawn failures land in stderr with code null. */
export function run(cmd, args, opts = {}) {
  return new Promise((res) => {
    let child;
    try {
      child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      res({ code: null, stdout: "", stderr: String(e), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const timer = opts.timeout ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeout * 1000) : undefined;
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      res({ code, stdout, stderr, timedOut });
    };
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { stderr += String(e); finish(null); });
    child.on("close", (code) => finish(code));
  });
}

/** Run a command and capture binary stdout (screencap, exec-out cat). */
export function runBuf(cmd, args, timeout = 30) {
  return new Promise((res) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      res({ code: -1, data: Buffer.alloc(0) });
      return;
    }
    const chunks = [];
    let done = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout * 1000);
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      res({ code, data: Buffer.concat(chunks) });
    };
    child.stdout.on("data", (d) => chunks.push(d));
    child.on("close", (code) => finish(code));
    child.on("error", () => finish(-1));
  });
}

/** Sleep that resolves early when `signal` aborts. */
export function sleep(ms, signal) {
  return new Promise((r) => {
    if (signal?.aborted) return r();
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); r(); }, ms);
    const onAbort = () => { clearTimeout(t); r(); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
