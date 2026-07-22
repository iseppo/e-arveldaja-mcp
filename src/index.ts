#!/usr/bin/env node
import { installStderrTee } from "./stderr-tee.js";
import { createMcpServer } from "./server-bootstrap.js";

installStderrTee();

createMcpServer().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal: ${msg}\n`);
  if (process.env.EARVELDAJA_DEBUG === "true" && err instanceof Error && err.stack) {
    process.stderr.write(`[debug] ${err.stack}\n`);
  }
  process.exit(1);
});
