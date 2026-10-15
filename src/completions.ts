// Shell completion scripts and the alias snippet. Static text on purpose:
// completions must work without spawning node on every <TAB>.
export const SHELLS = ["bash", "zsh", "fish"] as const;
export type Shell = (typeof SHELLS)[number];

const COMMANDS = [
  "install",
  "add",
  "i",
  "check",
  "scan",
  "doctor",
  "cache-clear",
  "completions",
  "alias",
  "run",
  "test",
  "exec",
  "remove",
  "uninstall",
  "update",
  "outdated",
  "audit",
  "ls",
];
const FLAGS = [
  "--all",
  "--yes",
  "--dev",
  "--peer",
  "--optional",
  "--workspace",
  "--registry",
  "--pm",
  "--dry-run",
  "--json",
  "--min-score",
  "--verbose",
  "--no-cache",
  "--no-snyk",
  "--no-color",
  "--save-exact",
  "--version",
  "--help",
];

export function completionScript(shell: Shell): string {
  const cmds = COMMANDS.join(" ");
  const flags = FLAGS.join(" ");
  if (shell === "bash") {
    return `# nps bash completion — add to ~/.bashrc:  eval "$(nps completions bash)"
_nps() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${cmds}" -- "$cur") )
  else
    case "$cur" in
      -*) COMPREPLY=( $(compgen -W "${flags}" -- "$cur") ) ;;
      *) COMPREPLY=( $(compgen -W "bun pnpm npm yarn brew bash zsh fish" -- "$cur") ) ;;
    esac
  fi
}
complete -F _nps nps
`;
  }
  if (shell === "zsh") {
    return `#compdef nps
# nps zsh completion — add to ~/.zshrc:  eval "$(nps completions zsh)"
_nps() {
  if (( CURRENT == 2 )); then
    compadd -- ${cmds}
  else
    compadd -- ${flags}
  fi
}
compdef _nps nps
`;
  }
  const lines = [
    "# nps fish completion — save as ~/.config/fish/completions/nps.fish",
    "complete -c nps -f",
    `complete -c nps -n '__fish_use_subcommand' -a '${cmds}'`,
    ...FLAGS.map((f) => `complete -c nps -l ${f.slice(2)}`),
  ];
  return lines.join("\n") + "\n";
}

export function aliasSnippet(): string {
  return `# Route installs through nps. Add to your shell rc file.
alias ni='nps install'      # ni express   -> intel + confirm + install
alias nic='nps check'       # nic express  -> intel only, never installs
alias nscan='nps scan'      # nscan        -> screen this project's dependencies
`;
}
