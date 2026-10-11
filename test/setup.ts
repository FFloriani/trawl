import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test run gets a throwaway home, so tests never touch ~/.trawl.
process.env.TRAWL_HOME = mkdtempSync(join(tmpdir(), "ss-test-"));
process.env.TRAWL_LOG = "error";
