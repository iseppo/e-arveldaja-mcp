#!/usr/bin/env node
import { syncWorkflowPromptSurfaces } from "./prompt-surface-files.js";

const count = await syncWorkflowPromptSurfaces(process.cwd());
console.log(`Synchronized ${count} Claude command prompt(s) from the canonical prompt registry.`);
