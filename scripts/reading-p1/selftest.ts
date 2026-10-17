// Auditor unit fixtures and the stage refusal (plan step 4 smoke): each fabricated violation must FAIL its audit,
// a clean fixture must pass, and a staging request with two cases must be refused without staging anything.
// Usage: npx tsx scripts/reading-p1/selftest.ts   → <data>/smoke/selftest.json; exit 1 on any unexpected result.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditClaudeCase, instructionFingerprints } from "./audit-claude.js";
import { auditCodexEvents } from "./audit-codex.js";
import { SCRIPTS_DIR, dataPath, manifest, sentinel, sha256Hex, writeJson } from "./common.js";
import { registryPath, stageRequest } from "./stage.js";
import { promptIS, promptIT, promptNT2 } from "./prompts.js";
import type { ReadingPacket } from "../../src/document-reading-packet.js";
import { makePacket } from "../../src/__fixtures__/document-reading/make-packet.js";
import { READERS, type CaseItem } from "./cases.js";
import type { PacketFile } from "./build-packets.js";
import { legacyPrompt, legacyShapeOk } from "./legacy.js";
import { candidatesFor, type FamilyA } from "./mutate.js";
import { caseWrongFields, wrongFields } from "./replay.js";
import { classifyEvidence } from "./restage.js";
import { injectedItems, parseRunArgs, todoItems } from "./step5.js";
import { truthDerivedReading } from "./synth-proof.js";
import { applyOverrides, type TruthRecord } from "./truth.js";

interface Check { name: string; expect: "pass" | "fail"; pass: boolean; failures: string[]; ok: boolean }

const SENTINEL = sentinel();
const PROMPT = "Read the packet and reply with a JSON object.\n";
const results: Check[] = [];
const record = (name: string, expect: Check["expect"], audit: { pass: boolean; failures: string[] }) => {
  results.push({ name, expect, pass: audit.pass, failures: audit.failures, ok: (expect === "pass") === audit.pass });
};
/** A harness property check (throughput round): `ok` is the property itself. */
const assert = (name: string, ok: boolean, detail = "") => {
  results.push({ name, expect: "pass", pass: ok, failures: ok ? [] : [detail || "property violated"], ok });
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

  // ---- A1 prompt wrappers (throughput round §2) -------------------------------------------------------------
  const packet = { source_sha256: "a".repeat(64), packet_digest: "d".repeat(64), text: "p1:001 │ Arve nr 1" } as unknown as ReadingPacket;
  const proofPrompts = { "I-S": promptIS(packet, {}), "I-T": promptIT(packet, {}), "N-T2": promptNT2(packet, "{}") };
  for (const [form, text] of Object.entries(proofPrompts)) assert(`prompt_${form}_do_not_wrap`, text.includes("do not wrap"), form);
  assert("prompt_I-S_no_both_object", !proofPrompts["I-S"].includes("{\"document_reading\": {...}, \"proof\": {...}}"));

  // ---- B1/B5: truth v2 scoring ------------------------------------------------------------------------------
  const truth = (extra: Partial<TruthRecord> = {}): TruthRecord => ({ id: "t1", status: "available", company: "1", doc_type: null, invoice_number: "BOOK-1", due_date: "2026-07-22", ...extra });
  const printed = truth({ due_date_printed: "2026-07-21" });
  assert("b1_printed_due_scored", wrongFields({ due_date: "2026-07-21" }, printed).length === 0 && wrongFields({ due_date: "2026-07-22" }, printed).includes("due_date"));
  const t5 = { t1: truth() };
  applyOverrides(t5, [{ doc: "t1", field: "invoice_number", value: "TG100", keep_as: "booking_reference", reason: "printed number", confirmed_by: "selftest" }]);
  applyOverrides(t5, [{ doc: "t1", field: "invoice_number", value: "TG100", keep_as: "booking_reference", reason: "printed number", confirmed_by: "selftest" }]);
  assert("b5_booking_reference_kept_unscored", t5.t1.invoice_number === "TG100" && t5.t1.booking_reference === "BOOK-1" && (t5.t1.truth_changes ?? []).length === 1 &&
    wrongFields({ invoice_number: "TG100" }, t5.t1).length === 0 && wrongFields({ invoice_number: "BOOK-1" }, t5.t1).includes("invoice_number"));
  let unconfirmed = false;
  try {
    applyOverrides({ t1: truth() }, [{ doc: "t1", field: "supplier_reg", unscore: true, reason: "ambiguous", confirmed_by: "" }]);
  } catch {
    unconfirmed = true;
  }
  assert("b5_unconfirmed_override_refused", unconfirmed);

  // ---- B4: schema-invalid readings are not scored ----------------------------------------------------------
  assert("b4_schema_invalid_not_scored", caseWrongFields({ reading: { net: "100", vat: "24", gross: "124" }, reading_schema: "reading_schema_invalid" }, truth({ net: 100, vat: 24, gross: 124 })).length === 0 &&
    caseWrongFields({ reading: { gross: 125 }, reading_schema: "ok" }, truth({ gross: 124 })).includes("gross"));

  // ---- B2/B3: base construction -------------------------------------------------------------------------------
  const iban = (bban: string) => {
    const digits = `${bban}EE00`.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
    const check = 98 - Number([...digits].reduce((acc, ch) => (acc * 10n + BigInt(ch)) % 97n, 0n));
    return `EE${String(check).padStart(2, "0")}${bban}`;
  };
  const [ibanA, ibanB] = [iban("2200221020145685"), iban("1010220012345678")];
  const invoice = ["Näidis OÜ    Arve nr A-17", "Reg. nr 10000018    KMKR EE100000007", "Ostja: Ostja AS    Reg. nr 10000024", "Kuupäev 15.03.2026",
    "Makse tähtpäev:    16.08.2026", `IBAN ${ibanA}    ${ibanB}`, "Summa ilma KM-ta 100,00", "KM 24% 24,00", "Kokku EUR 124,00"];
  const fixtureFile = { id: "t1", path: "t1.pdf", packet: makePacket(invoice), heuristic: { signals: [], confidence: "high", labelled: {} }, heuristic_fields: {} } as unknown as PacketFile;
  const fixtureTruth = truth({ invoice_date: "2026-03-15", invoice_number: "A-17", due_date: "2026-08-16", supplier_reg: "10000018", supplier_vat: "EE100000007", supplier_iban: null,
    currency: "EUR", net: 100, vat: 24, gross: 124, unscored_fields: ["supplier_iban"], supplier_ibans_printed: [ibanA, ibanB] });
  const fixtureBase = truthDerivedReading(fixtureFile, fixtureTruth, { reg: "10000024", vat: null, name: "Ostja AS" });
  assert("b2_tahtpaev_due_date", fixtureBase.dropped === undefined && fixtureBase.reading.due_date === "2026-08-16", JSON.stringify({ dropped: fixtureBase.dropped, due: fixtureBase.reading.due_date }));
  assert("b3_base_first_printed_iban", fixtureBase.reading.supplier_iban === ibanA, String(fixtureBase.reading.supplier_iban));
  const ibanCandidates = (equivalent: string[]) => candidatesFor("t1", fixtureFile.packet, "supplier_iban", ibanA, equivalent).map((candidate) => candidate.value);
  assert("b3_equivalent_iban_no_candidate", !ibanCandidates([ibanA, ibanB]).includes(ibanB) && ibanCandidates([]).includes(ibanB));

  // ---- B6: legacy prompt and output shape ---------------------------------------------------------------------
  const legacy = legacyPrompt();
  assert("b6_legacy_prompt", !legacy.includes("Final reply") && legacy.includes("do not run any commands or read any files"));
  assert("b6_legacy_shape", !legacyShapeOk({ confirm: 15, problem: 18 }) && !legacyShapeOk([{ case: "C01" }]) &&
    legacyShapeOk(Array.from({ length: 33 }, (_, index) => ({ case: `C${index + 1}` }))));

  // ---- B7: transport only on positive evidence ----------------------------------------------------------------
  const kind = (failures: string[], error_messages: string[] = [], run_errors: string[] = []) => classifyEvidence({ failures, error_messages, run_errors }).kind;
  assert("b7_no_events_no_output_stop", kind(["turn1_no_output"]) === "stop" && kind(["turn1_output_missing"]) === "stop");
  assert("b7_stream_disconnected_transport", kind(["turn1_forbidden:event:error"], ["stream disconnected before completion"]) === "transport");
  assert("b7_transport_plus_unknown_stop", kind(["turn1_forbidden:event:error", "turn1_unknown"], ["stream disconnected before completion"]) === "stop");
  assert("b7_empty_failures_stop", kind([]) === "stop" && kind([], ["stream disconnected"]) === "stop");
  assert("b7_mixed_messages_stop", kind(["turn1_forbidden:event:error"], ["stream disconnected", "invalid json schema"]) === "stop");
  assert("b7_transport_plus_leak_stop", kind(["turn1_forbidden:event:error", "turn1_sentinel"], ["stream disconnected"]) === "stop");
  assert("b7_run_error_transport", kind(["run:turn1", "turn1_output_missing"], [], ["turn1:connection reset by peer"]) === "transport");

  // B7/B9 retry chain, in a temp data dir: an earlier transport link does not excuse a later unexplained or leak
  // failure, and a transport retry is still refused once the caps are exceeded. No reader can start: either the
  // classification stops, or the cap callback (always exceeded here) does, before any case is staged.
  const restageChain = (second: { failures: string[]; run_errors?: string[] }, secondEvents: string[]) => {
    const dir = join(root, `chain-${sha256Hex(JSON.stringify(second)).slice(0, 8)}`);
    for (const sub of ["staging", "leakage", "a", "b"]) mkdirSync(join(dir, sub), { recursive: true });
    const [a, b] = ["c-aaaaaaaaaaaa", "c-bbbbbbbbbbbb"];
    writeFileSync(join(dir, "staging", `${a}.json`), JSON.stringify({ case_id: a, reader: "codex", form: "N-S", kind: "natural", doc_id: "01", turns: 1, dir: join(dir, "a"), meta: { run: "chain" }, restaged_as: b }));
    writeFileSync(join(dir, "staging", `${b}.json`), JSON.stringify({ case_id: b, reader: "codex", form: "N-S", kind: "natural", doc_id: "01", turns: 1, dir: join(dir, "b"), meta: { run: "chain", restaged_from: a } }));
    writeFileSync(join(dir, "leakage", `${a}.json`), JSON.stringify({ pass: false, failures: ["turn1_forbidden:event:error"], run_errors: [] }));
    writeFileSync(join(dir, "leakage", `${b}.json`), JSON.stringify({ pass: false, run_errors: [], ...second }));
    writeFileSync(join(dir, "b", "events1.jsonl"), secondEvents.map((message) => JSON.stringify({ type: "error", message })).join("\n"));
    const code = `import(${JSON.stringify(join(SCRIPTS_DIR, "restage.ts"))}).then(async (m) => { process.stdout.write(String(await m.restageRun({ tag: "chain", max: 2, exceeds: () => true, log: () => {} }))); })`;
    return execFileSync("npx", ["tsx", "--eval", code], { encoding: "utf8", env: { ...process.env, READING_P1_DATA_DIR: dir } }).trim();
  };
  const chainLeak = restageChain({ failures: ["turn1_forbidden:event:error", "turn1_sentinel"] }, ["stream disconnected"]);
  assert("b7_chain_leak_after_transport_stops", chainLeak.startsWith("leakage:c-bbbbbbbbbbbb"), chainLeak);
  const chainUnexplained = restageChain({ failures: ["turn1_output_missing"] }, []);
  assert("b7_chain_unexplained_after_transport_stops", chainUnexplained.startsWith("leakage:c-bbbbbbbbbbbb"), chainUnexplained);
  const chainTransport = restageChain({ failures: ["turn1_forbidden:event:error"] }, ["stream disconnected"]);
  assert("b9_chain_retry_counts_against_caps", chainTransport.startsWith("projection exceeds the chain caps"), chainTransport);

  // ---- B9: run isolation and caps -----------------------------------------------------------------------------
  const usage = (argv: string[]) => "error" in parseRunArgs(argv);
  assert("b9_usage_errors", usage([]) && usage(["--run", "step5b"]) && usage(["--run", "step5", "--cap-input", "1", "--cap-output", "1"]) &&
    usage(["--run", "x", "--cap-input", "99000000", "--cap-output", "1"]) && !usage(["--run", "step5b", "--cap-input", "8000000", "--cap-output", "2500000"]));
  const planned = ["k1", "k2", "k3"].map((key) => ({ spec: { meta: { key } } }) as unknown as CaseItem);
  const otherTag = [{ meta: { run: "step5", key: "k1" } }, { meta: { run: "step5", key: "k2" } }];
  assert("b9_other_tag_does_not_reduce_todo", todoItems(planned, otherTag, "step5b").length === 3 &&
    todoItems(planned, [...otherTag, { meta: { run: "step5b", key: "k3" } }], "step5b").length === 2);
  const doc = manifest("corpus")[0]!.id;
  const family = (n: number) => ({
    sampled: Array.from({ length: n }, (_, index) => ({ doc_id: doc, field: "gross", field_type: "amount", value: index + 1, line: "p1:001", quote: "x" })),
    admitted_bases: [{ doc_id: doc, reading: { evidence: {} }, sources: {} }],
  }) as unknown as FamilyA;
  const iCount = (n: number) => injectedItems("selftest", family(n)).length;
  assert("b9_i_cases_from_a_json", iCount(1) === READERS.length * 2 * 2 && iCount(3) === READERS.length * 2 * 2 * 3, `${iCount(1)}/${iCount(3)}`);

  // ---- B8: corpus scope never reads the held-out set ----------------------------------------------------------
  const scoped = join(root, "scoped-data");
  for (const sub of ["corpus", "packets", "results", "readings", "heldout"]) mkdirSync(join(scoped, sub), { recursive: true });
  writeFileSync(join(scoped, "corpus", "files.txt"), "doc1.pdf\n");
  writeFileSync(join(scoped, "corpus", "sha256.txt"), `${"a".repeat(64)}  doc1.pdf\n`);
  writeFileSync(join(scoped, "corpus", "truth.json"), "{}");
  writeFileSync(join(scoped, "packets", "01.json"), JSON.stringify({ id: "01", path: "doc1.pdf", packet: makePacket(["Arve 1"]), heuristic: {}, heuristic_fields: {} }));
  writeFileSync(join(scoped, "results", "scoped.json"), JSON.stringify([{ case_id: "c-000000000001", reader: "opus", form: "N-S", kind: "natural", doc_id: "01", set: "corpus", truth_available: false,
    reading_schema: "ok", proof_schema: "ok", leakage_pass: true, wrong_fields: [], proof_problem_fields: [], passes: {}, usage: { input: 1, cached_input: 0, output: 1, reasoning_output: 0 }, models: [] }]));
  writeFileSync(join(scoped, "readings", "c-000000000002.json"), JSON.stringify({ case_id: "c-000000000002", reader: "opus", form: "N-S", kind: "natural", doc_id: "h01", meta: { run: "scoped" }, turns: [], reading: {}, proof: null, leakage_pass: true }));
  writeFileSync(join(scoped, "heldout", "files.txt"), "secret.pdf\n");
  writeFileSync(join(scoped, "packets", "h01.json"), "{}");
  chmodSync(join(scoped, "packets", "h01.json"), 0o000);
  chmodSync(join(scoped, "heldout"), 0o000);
  const scopedRun = (script: string, args: string[]) => {
    try {
      execFileSync("npx", ["tsx", join(SCRIPTS_DIR, script), ...args], { encoding: "utf8", stdio: "pipe", env: { ...process.env, READING_P1_DATA_DIR: scoped } });
      return "";
    } catch (error) {
      return String((error as { stderr?: string }).stderr ?? error).slice(0, 300);
    }
  };
  const reportError = scopedRun("report.ts", ["--run", "scoped", "--scope", "corpus", "--projection", "--full"]);
  assert("b8_report_corpus_scope_no_heldout_read", reportError === "", reportError);
  const replayError = scopedRun("replay.ts", ["--run", "scoped", "--scope", "corpus"]);
  assert("b8_replay_corpus_scope_skips_heldout", replayError === "", replayError);
  chmodSync(join(scoped, "heldout"), 0o700);
  chmodSync(join(scoped, "packets", "h01.json"), 0o600);
  const heldoutLiteral = ["report.ts", "replay.ts", "step5.ts", "restage.ts", "mutate.ts"].filter((name) => {
    const text = readFileSync(join(SCRIPTS_DIR, name), "utf8");
    return text.includes('"heldout"') || text.includes('startsWith("h")');
  });
  assert("b8_no_heldout_literal_in_scoped_scripts", heldoutLiteral.length === 0, heldoutLiteral.join(","));
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
