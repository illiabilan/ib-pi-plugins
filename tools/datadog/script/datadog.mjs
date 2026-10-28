#!/usr/bin/env node
import { main } from "./cli.mjs";

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
