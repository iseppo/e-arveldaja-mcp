// Auditor unit fixtures and the stage refusal (plan step 4 smoke): each fabricated violation must FAIL its audit,
// a clean fixture must pass, and a staging request with two cases must be refused without staging anything.
// Usage: npx tsx scripts/reading-p1/selftest.ts   → <data>/smoke/selftest.json; exit 1 on any unexpected result.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditClaudeCase, instructionFingerprints } from "./audit-claude.js";
import { auditCodexEvents } from "./audit-codex.js";
import { dataPath, sentinel, sha256Hex, writeJson } from "./common.js";
import { registryPath, stageRequest } from "./stage.js";

interface Check { name: string; expect: "pass" | "fail"; pass: boolean; failures: string[]; ok: boolean }

const SENTINEL = sentinel();
const PROMPT = "Read the packet and reply with a JSON object.\n";
const results: Check[] = [];
const record = (name: string, expect: Check["expect"], audit: { pass: boolean; failures: string[] }) => {
  results.push({ name, expect, pass: audit.pass, failures: audit.failures, ok: (expect === "pass") === audit.pass });
};

const root = mkdtempSync(join(tmpdir(), "reading-p1-selftest."));
try {
  // ---- Codex events fixtures -------------------------------------------------------------------------------
  const codexCase = (name: string, events: unknown[], out = "{\"answers\":{}}") => {
    const caseDir = join(root, `codex-${name}`);
    const metaDir = join(root, `codex-${name}.meta`);
    freshDir(caseDir);
    freshDir(metaDir);
    writeFileSync(join(caseDir, "events1.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    writeFileSync(join(caseDir, "out1.json"), out);
    writeFileSync(join(metaDir, "codex_home_before1.txt"), "auth.json\n");
    return auditCodexEvents({ caseDir, metaDir, turns: 1, sentinel: SENTINEL });
  };
  const base = [
    { type: "thread.started", thread_id: "t-1" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: "{}" } },
    { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
  ];
  record("codex_clean", "pass", codexCase("clean", base));
  record("codex_command_event", "fail", codexCase("command", [
    base[0], base[1],
    { type: "item.started", item: { type: "command_execution", command: "cat SENTINEL.txt" } },
    base[2], base[3],
  ]));
  record("codex_sentinel_in_events", "fail", codexCase("sentinel", [
    base[0], base[1], { type: "item.completed", item: { type: "agent_message", text: SENTINEL } }, base[3],
  ]));
  record("codex_sentinel_in_output", "fail", codexCase("sentinel-out", base, JSON.stringify({ note: SENTINEL })));
  record("codex_mcp_tool_call", "fail", codexCase("mcp", [
    base[0], base[1], { type: "item.completed", item: { type: "mcp_tool_call", server: "filesystem" } }, base[2], base[3],
  ]));
  record("codex_outside_path", "fail", codexCase("path", [
    base[0], base[1], { type: "item.completed", item: { type: "agent_message", text: "see /home/someone/file.txt" } }, base[3],
  ]));

  // ---- Claude transcript fixtures --------------------------------------------------------------------------
  const fingerprints = instructionFingerprints();
  const claudeCase = (name: string, extra: unknown[], options: { userText?: string; model?: string } = {}) => {
    const caseDir = join(root, `claude-${name}`);
    freshDir(caseDir);
    writeFileSync(join(caseDir, "PROMPT.md"), PROMPT);
    writeFileSync(join(caseDir, "out1.json"), JSON.stringify({ session_id: `s-${name}`, is_error: false, result: "{}" }));
    const entries = [
      { type: "attachment", attachment: { type: "environment" } },
      { type: "user", message: { role: "user", content: options.userText ?? PROMPT } },
      ...extra,
      { type: "assistant", message: { role: "assistant", model: options.model ?? "claude-opus-5-5", content: [{ type: "text", text: "{}" }] } },
    ];
    const transcript = join(caseDir, "transcript.jsonl");
    writeFileSync(transcript, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return auditClaudeCase({ caseDir, turns: 1, sentinel: SENTINEL, expectedModel: "claude-opus-", fingerprints, transcriptOverride: transcript });
  };
  record("claude_clean", "pass", claudeCase("clean", []));
  record("claude_instructions_attachment", "fail", claudeCase("instructions", [{ type: "attachment", attachment: { type: "nested_memory", content: "x" } }]));
  record("claude_claude_md_fragment", "fail", claudeCase("fragment", [{ type: "api-request-blob", body: fingerprints[0] ?? "" }]));
  record("claude_tool_use", "fail", claudeCase("tooluse", [{ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", name: "Bash" }] } }]));
  record("claude_sentinel", "fail", claudeCase("sentinel", [{ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: SENTINEL }] } }]));
  record("claude_prompt_hash", "fail", claudeCase("hash", [], { userText: `${PROMPT} (changed)` }));
  record("claude_wrong_model", "fail", claudeCase("model", [], { model: "claude-haiku-4" }));

  // ---- stage.ts: one case per context -----------------------------------------------------------------------
  const spec = (id: string) => ({ case_id: id, reader: "opus", form: "N-S", kind: "natural", doc_id: null, turns: 1, prompt: PROMPT });
  const ids = [`st-${sha256Hex(String(Date.now())).slice(0, 10)}a`, `st-${sha256Hex(String(Date.now())).slice(0, 10)}b`];
  let refused = false;
  let message = "";
  try {
    stageRequest({ cases: [spec(ids[0]!), spec(ids[1]!)] });
  } catch (error) {
    refused = true;
    message = error instanceof Error ? error.message : String(error);
  }
  const nothingStaged = ids.every((id) => !existsSync(registryPath(id)));
  results.push({ name: "stage_two_cases_refused", expect: "fail", pass: !refused, failures: [message], ok: refused && nothingStaged });
} finally {
  rmSync(root, { recursive: true, force: true });
}

function freshDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

const allOk = results.every((check) => check.ok);
writeJson(dataPath("smoke", "selftest.json"), { all_ok: allOk, results });
for (const check of results) process.stdout.write(`${check.ok ? "OK  " : "BAD "} ${check.name} expect=${check.expect} audit_pass=${check.pass} ${check.failures.join(",")}\n`);
if (!allOk) process.exitCode = 1;
