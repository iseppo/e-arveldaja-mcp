# Guided surface — tool-addition policy

The `guided` / `guided-sales` profiles are the small, opt-in daily-bookkeeping
surfaces. Their value is *routing clarity*: few, distinct, obvious tools so the
model reliably picks the right one for the daily loop. This policy governs when
a tool earns a place there.

## The cap (relaxed 2026-07)

Earlier work treated **20** as an inviolable hard cap. Per-tool measurement
(2026-07) showed the guided surface costs ≈ 6.9k tokens with **no cost cliff at
20** — cost is roughly linear in schema bytes, not tool count. The cap therefore
protects *clarity*, not a token budget, so it is a **target with a bounded
exception band**, not an absolute wall:

- **Target: ≤ 20 tools.** The clarity sweet spot. Stay here by default.
- **Exception band: 21–24.** Permitted only when the add-criteria below *all*
  hold AND no existing tool can absorb the capability. Exceeding 20 requires a
  recorded decision — a `CHANGELOG` entry naming the new count and the one-line
  reason — never a silent bump.
- **Hard backstop: 24.** Beyond 24 the surface stops being "guided." A guided
  count > 24 is a redesign signal: **merge tools, don't add.**

`guided-sales` = `guided` + `manage_sale_invoice`, so it tracks exactly one
above `guided`; the same target/band/backstop apply.

## When to ADD a new guided tool — all four must hold

1. **Distinct capability.** Nothing in guided already does it, and no existing
   façade can absorb it as another `mode`/parameter without becoming incoherent.
2. **Daily-path relevance.** It belongs to the common daily loop — bank import,
   document intake, reconciliation, review, reporting. Occasional, admin,
   configuration, or diagnostic actions are not daily-path.
3. **Reachable as a visible next action.** Some guided workflow legitimately
   points at it as a next step, and a journey contract can prove it. If no
   workflow references it, it does not belong in guided.
4. **Routing clarity preserved.** It is not a near-duplicate of an existing
   entry point — adding it must not create "which one do I use?" ambiguity.

## When NOT to add — route or merge instead

- **Variant of an existing operation** → add a `mode` to that tool. Follow the
  established `read`/`prepare`/`execute` and `search`/`inspect` mode patterns.
- **Admin / config / diagnostic / one-off** → register it in `standard`/`full`
  only. This is why `get_server_status`, `create_bank_account`, and the
  credential-management tools are not in guided.
- **Only reachable mid-workflow, server-side** → make it a
  `continue_accounting_workflow` continuation executed through a typed
  operation, not a top-level tool.
- **Would push guided past 20 and an adjacent pair could merge** → merge first.

## Process when a genuinely-needed tool would exceed 20

1. Try to absorb it into an existing façade as a new `mode`.
2. Try to merge two adjacent, distinct tools to free a slot.
3. Only if neither works: add it, and record the deliberate exception (new
   count + rationale) in `CHANGELOG`. Never exceed 24.

## Standing merge candidates (headroom, if ever needed)

- **`search_accounting_records` + `inspect_accounting_record`** → one read tool
  with `mode=search|inspect`. Both read-only, same domain, mirrors the existing
  mode-merge pattern. Clean, low-risk; frees 1 slot.
- **`cleanup_camt_possible_duplicate` + `save_auto_booking_rule`** → fold into
  `continue_accounting_workflow` as server-executed continuations. Needs
  relaxing that tool's `readOnly` annotation for those specific continuations;
  frees 2 slots and dissolves the recurring placement tension.
- **Do NOT merge** `get_execution_plan_page` / `get_operation_result_page` /
  `get_session_log` (distinct security boundaries: pre-consumption review vs.
  post-execution results vs. audit trail) or `list_connections` /
  `switch_connection` (read vs. mutation). Marginal savings, boundary-blurring
  risk.
