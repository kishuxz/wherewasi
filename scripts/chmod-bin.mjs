#!/usr/bin/env node
/**
 * Restores the executable bit on every `bin` entry after a build.
 *
 * `tsc` does not preserve mode, so each build leaves the entry point at 0644
 * with a correct shebang and no permission to use it. Doing this by hand does
 * not stick: `prebuild` runs `rm -rf dist`, so the bit is lost again on the
 * next build.
 *
 * Read from `bin` rather than hardcoded, so renaming or adding an entry point
 * cannot silently leave it unexecutable. Uses node's own chmod rather than a
 * shell `chmod` so the build does not depend on a POSIX shell.
 */
import { chmodSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const entries = Object.values(pkg.bin ?? {});
if (!entries.length) {
  console.error("chmod-bin: package.json has no bin entries — nothing to do");
  process.exit(0);
}

for (const target of entries) {
  const file = new URL(`../${target}`, import.meta.url);
  chmodSync(file, 0o755);
}
