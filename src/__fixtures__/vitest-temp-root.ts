// Vitest setup (unit and integration configs, listed first): every test file
// gets its own temp root, and os.tmpdir() points into it, so every mkdtemp a
// test or the code under test makes lands there and is removed with the root
// after the file. Before this, tests that never removed their mkdtemp dirs
// left ~125 000 directories in /tmp.
//
// A run killed before afterAll (a worker crash, a timeout, an interrupted
// agent) cannot clean up, so each file also removes roots of earlier runs that
// are older than STALE_MS. Roots of runs going on in parallel (other
// worktrees) are younger and are left alone.
import { mkdtempSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll } from "vitest";

const PREFIX = "earveldaja-vitest-";
const STALE_MS = 24 * 60 * 60 * 1000;

const systemTmp = tmpdir();

function removeStaleRoots(): void {
  let entries: string[];
  try {
    entries = readdirSync(systemTmp);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_MS;
  for (const name of entries) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(systemTmp, name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
    } catch {
      // Another process removed it, or it is not ours to remove.
    }
  }
}

removeStaleRoots();

const root = mkdtempSync(join(systemTmp, PREFIX));
// os.tmpdir() reads TMPDIR on every call (POSIX); TEMP/TMP cover Windows.
process.env.TMPDIR = root;
process.env.TEMP = root;
process.env.TMP = root;

afterAll(() => {
  process.env.TMPDIR = systemTmp;
  process.env.TEMP = systemTmp;
  process.env.TMP = systemTmp;
  rmSync(root, { recursive: true, force: true });
});
