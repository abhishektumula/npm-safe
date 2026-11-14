// One table of nps's commands and flags, shared by per-command help
// (`nps help <cmd>`, `nps <cmd> --help`) and the shell completion scripts,
// so <TAB> descriptions and help text can't drift apart. The full overview
// stays in cli.ts `helpText()`.
import { c, paint } from "./colors.ts";

export interface CommandInfo {
  name: string;
  /** other names that route to this command */
  aliases?: string[];
  /** one line, shown next to the name on <TAB> (zsh/fish) */
  summary: string;
  usage: string[];
  /** extra lines for `nps help <cmd>` (examples, notes) */
  details?: string[];
}

export const COMMANDS: CommandInfo[] = [
  {
    name: "install",
    aliases: ["i", "add"],
    summary: "inspect, confirm, then install",
    usage: [
      "nps install <pkg...> [flags]",
      "nps install            (no packages: install project deps)",
    ],
    details: [
      "nps install express lodash -a     full detail for two packages",
      'nps add "express@5" -D            pin a range, save as devDependency',
      "nps express -y                    bare names also mean install",
      "Flags: -a -y -D -P -O -E -w --registry --pm --min-score --dry-run --json",
    ],
  },
  {
    name: "check",
    summary: "inspect only, never installs",
    usage: ["nps check <pkg...> [flags]"],
    details: [
      "Same intel as install with --dry-run. Exits 3 when a policy fails,",
      "so it works as a CI gate: nps check left-pad --min-score 60",
    ],
  },
  {
    name: "scan",
    summary: "screen this project's dependencies",
    usage: ["nps scan [--prod] [--json] [--min-score <n>]"],
    details: [
      "Intel for every dependency in package.json (version on disk when",
      "installed), worst first. --prod skips devDependencies. Workspace",
      "members, non-registry deps and nps itself are left out.",
    ],
  },
  {
    name: "doctor",
    summary: "check manager, registry, Snyk, OSV, cache",
    usage: ["nps doctor"],
  },
  {
    name: "cache-clear",
    summary: "delete nps's intel cache",
    usage: ["nps cache-clear"],
  },
  {
    name: "completions",
    summary: "shell <TAB> completion (bash, zsh, fish)",
    usage: ["nps completions install [bash|zsh|fish]", "nps completions <bash|zsh|fish>"],
    details: [
      "install   set it up for your shell (detected from $SHELL); safe to re-run",
      '<shell>   print the script, e.g. eval "$(nps completions zsh)"',
    ],
  },
  {
    name: "alias",
    summary: "print handy shell aliases (ni, nic, nscan)",
    usage: ["nps alias"],
  },
  {
    name: "help",
    summary: "help for nps or one command",
    usage: ["nps help [command]", "nps <command> --help"],
  },
  {
    name: "run",
    summary: "run a package.json script via your manager",
    usage: ["nps run <script> [args]"],
  },
  { name: "test", summary: "run tests via your manager", usage: ["nps test [args]"] },
  {
    name: "exec",
    summary: "run a package binary via your manager",
    usage: ["nps exec <bin> [args]"],
  },
  {
    name: "uninstall",
    aliases: ["remove"],
    summary: "remove a dependency",
    usage: ["nps uninstall <pkg...>"],
  },
  {
    name: "update",
    summary: "update dependencies via your manager",
    usage: ["nps update [pkg...]"],
  },
  { name: "outdated", summary: "list outdated dependencies", usage: ["nps outdated"] },
  { name: "audit", summary: "your manager's audit", usage: ["nps audit"] },
  { name: "ls", summary: "list installed dependencies", usage: ["nps ls"] },
];

export interface FlagInfo {
  long: string;
  short?: string;
  summary: string;
  /** completion values for the flag's argument */
  values?: string[];
}

export const PMS = ["npm", "bun", "pnpm", "yarn", "brew"];

export const FLAGS: FlagInfo[] = [
  { long: "--all", short: "-a", summary: "full detail" },
  { long: "--yes", short: "-y", summary: "skip the [y/N] prompt" },
  { long: "--dev", short: "-D", summary: "save as devDependency" },
  { long: "--peer", short: "-P", summary: "save as peerDependency" },
  { long: "--optional", short: "-O", summary: "save as optionalDependency" },
  { long: "--save-exact", short: "-E", summary: "pin the exact version" },
  { long: "--workspace", short: "-w", summary: "target a workspace package" },
  { long: "--registry", summary: "use a private registry" },
  { long: "--pm", summary: "force the package manager", values: PMS },
  { long: "--min-score", summary: "block below this health score" },
  { long: "--dry-run", summary: "show intel, install nothing" },
  { long: "--json", summary: "machine-readable report" },
  { long: "--prod", summary: "scan: skip devDependencies" },
  { long: "--verbose", summary: "diagnostics on stderr" },
  { long: "--no-cache", summary: "skip the intel cache" },
  { long: "--no-snyk", summary: "skip the Snyk health scrape" },
  { long: "--no-color", summary: "plain output" },
  { long: "--version", short: "-v", summary: "print version" },
  { long: "--help", short: "-h", summary: "show help" },
];

/** Command by name or alias. */
export function findCommand(name: string): CommandInfo | undefined {
  return COMMANDS.find((cmd) => cmd.name === name || cmd.aliases?.includes(name));
}

/** Help for one command, or null when nps has no such command. */
export function commandHelp(name: string): string | null {
  const cmd = findCommand(name);
  if (!cmd) return null;
  const aka = cmd.aliases?.length ? paint(c.dim, `  (also: ${cmd.aliases.join(", ")})`) : "";
  const lines = [
    "",
    `  ${paint(c.pink, `◆ nps ${cmd.name}`)}${aka}  ${paint(c.dim, `— ${cmd.summary}`)}`,
    "",
    `  ${paint(c.cyan, "usage")}`,
    ...cmd.usage.map((u) => `    ${u}`),
  ];
  if (cmd.details?.length) lines.push("", ...cmd.details.map((d) => `    ${d}`));
  lines.push("", paint(c.dim, "  All commands and flags: nps --help"), "");
  return lines.join("\n");
}
