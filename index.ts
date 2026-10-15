#!/usr/bin/env node
import { setColorEnabled } from "./src/colors.ts";
import { run } from "./src/cli.ts";

// Pipes and files get plain text unless FORCE_COLOR asks otherwise.
if (process.stdout.isTTY !== true && !process.env.FORCE_COLOR) setColorEnabled(false);

await run(process.argv.slice(2));
