// Fake mitmdump for tests: listens on --listen-port until SIGTERM and writes one log line to $VQA_LOG.
// Its command line contains "mitmdump" and "mock_addon.py", like the real one, so pid verification passes.
import { appendFileSync } from "node:fs";
import { createServer } from "node:net";

if (!process.env.VQA_LOG) process.exit(0); // picked up by the test runner glob: do nothing
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--listen-port") + 1]);
const srv = createServer((s) => s.end()).listen(port, "127.0.0.1", () => {
  appendFileSync(process.env.VQA_LOG, `00:00:00 MATCH GET https://api.example.com/${process.env.VQA_MATCH} fixture=passthrough body=\n`);
});
process.on("SIGTERM", () => srv.close(() => process.exit(0)));
