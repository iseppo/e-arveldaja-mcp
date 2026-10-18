// Registers the parse-cache resolve hook (P2 §4 batch replay): run as
//   npx tsx --import ./scripts/reading-p2/register.mjs scripts/reading-p2/batch-replay.ts …
import { register } from "node:module";

register("./parse-cache-hooks.mjs", import.meta.url);
