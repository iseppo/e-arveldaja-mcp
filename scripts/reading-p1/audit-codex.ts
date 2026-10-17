// Leakage audit of one Codex reader case (plan §5.3) over events1.jsonl / events2.jsonl. The case fails on:
//   - any command-execution, file-change, MCP, web-search or other non-message item (none is needed);
//   - any absolute path outside the case dir;
//   - the sentinel (events and outputs);
//   - a thread id that differs between the turns;
//   - a CODEX_HOME that held anything but auth.json before turn 1, or user config/instructions before turn 2;
//   - an MCP server announced on stderr.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ALLOWED_EVENT_TYPES = new Set(["thread.started", "turn.started", "turn.completed", "item.started", "item.updated", "item.completed"]);
const ALLOWED_ITEM_TYPES = new Set(["agent_message", "reasoning"]);
/** Files whose presence in CODEX_HOME would mean user configuration or instructions leaked in. */
const FORBIDDEN_HOME_ENTRIES = ["config.toml", "AGENTS.md", "AGENTS.override.md", "rules", "memories", "hooks.json"];
const ABSOLUTE_PATH_RE = /(?<![\w.])\/(?:home|tmp|etc|root|usr|var|opt|mnt|media|srv)\/[^\s"'\\)]*/g;

export interface CodexTurnAudit {
  turn: number;
  thread_id: string | null;
  events: number;
  event_types: string[];
  item_types: string[];
  forbidden_items: string[];
  outside_paths: string[];
  sentinel_hit: boolean;
  failed_turn: boolean;
  usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number } | null;
}

export interface CodexAudit {
  reader: "codex";
  turns: CodexTurnAudit[];
  codex_home_before1: string[];
  codex_home_before2: string[] | null;
  same_thread: boolean;
  failures: string[];
  pass: boolean;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: { type?: string };
  usage?: CodexTurnAudit["usage"];
}

export function auditCodexEvents(input: { caseDir: string; metaDir: string; turns: number; sentinel: string; eventsOverride?: string[] }): CodexAudit {
  const failures: string[] = [];
  const turns: CodexTurnAudit[] = [];
  for (let turn = 1; turn <= input.turns; turn++) {
    const path = input.eventsOverride?.[turn - 1] ?? join(input.caseDir, `events${turn}.jsonl`);
    const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (!raw) failures.push(`turn${turn}_events_missing`);
    const events = raw.split("\n").filter(Boolean).map((line) => {
      try {
        return JSON.parse(line) as CodexEvent;
      } catch {
        return { type: "unparseable" } as CodexEvent;
      }
    });
    const eventTypes = [...new Set(events.map((event) => event.type ?? "?"))];
    const itemTypes = [...new Set(events.filter((event) => event.item).map((event) => event.item!.type ?? "?"))];
    const forbiddenItems = [
      ...eventTypes.filter((type) => !ALLOWED_EVENT_TYPES.has(type)).map((type) => `event:${type}`),
      ...itemTypes.filter((type) => !ALLOWED_ITEM_TYPES.has(type)).map((type) => `item:${type}`),
    ];
    const outside = [...new Set([...raw.matchAll(ABSOLUTE_PATH_RE)].map((match) => match[0]).filter((path) => path !== input.caseDir && !path.startsWith(`${input.caseDir}/`)))];
    const outPath = join(input.caseDir, `out${turn}.json`);
    const out = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
    if (!out) failures.push(`turn${turn}_output_missing`);
    const sentinelHit = raw.includes(input.sentinel) || out.includes(input.sentinel);
    const completed = events.find((event) => event.type === "turn.completed");
    const audit: CodexTurnAudit = {
      turn,
      thread_id: events.find((event) => event.type === "thread.started")?.thread_id ?? null,
      events: events.length,
      event_types: eventTypes,
      item_types: itemTypes,
      forbidden_items: forbiddenItems,
      outside_paths: outside,
      sentinel_hit: sentinelHit,
      failed_turn: !completed,
      usage: completed?.usage ?? null,
    };
    if (forbiddenItems.length > 0) failures.push(`turn${turn}_forbidden:${forbiddenItems.join(",")}`);
    if (outside.length > 0) failures.push(`turn${turn}_outside_path`);
    if (sentinelHit) failures.push(`turn${turn}_sentinel`);
    if (audit.failed_turn) failures.push(`turn${turn}_not_completed`);
    const stderrPath = join(input.metaDir, `stderr${turn}.txt`);
    if (existsSync(stderrPath) && /\bmcp\b.*\b(start|server|ready|connect)/i.test(readFileSync(stderrPath, "utf8"))) failures.push(`turn${turn}_mcp_server`);
    turns.push(audit);
  }
  const listing = (name: string) => {
    const path = join(input.metaDir, name);
    return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : null;
  };
  const before1 = listing("codex_home_before1.txt") ?? [];
  if (before1.length !== 1 || before1[0] !== "auth.json") failures.push("codex_home_not_auth_only");
  const before2 = input.turns === 2 ? listing("codex_home_before2.txt") : null;
  if (before2 && before2.some((entry) => FORBIDDEN_HOME_ENTRIES.includes(entry))) failures.push("codex_home_user_config_before_turn2");
  const threadIds = turns.map((turn) => turn.thread_id);
  // `exec resume` may omit thread.started; an absent id is not a different id.
  const sameThread = threadIds.filter((id) => id !== null).every((id) => id === threadIds[0]) && threadIds[0] !== null;
  if (!sameThread) failures.push("thread_changed");
  return { reader: "codex", turns, codex_home_before1: before1, codex_home_before2: before2, same_thread: sameThread, failures: [...new Set(failures)], pass: failures.length === 0 };
}
