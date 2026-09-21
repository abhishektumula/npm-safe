#!/usr/bin/env node
import { run } from "./src/cli.ts";

await run(process.argv.slice(2));
