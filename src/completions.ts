// Shell completion scripts and the alias snippet. Static text on purpose:
// completions must work without spawning node on every <TAB>. Commands,
// flags and their descriptions come from help.ts so <TAB> and `nps help`
// always agree. <TAB> offers nps's commands — never file names.
import { COMMANDS, FLAGS, PMS } from "./help.ts";

export const SHELLS = ["bash", "zsh", "fish"] as const;
export type Shell = (typeof SHELLS)[number];

const NAMES = COMMANDS.map((cmd) => cmd.name);
/** Flags whose next word is a free-form value (no completion). */
const VALUE_FLAGS = ["--registry", "--workspace", "-w", "--min-score"];
const COMPLETIONS_ARGS = ["install", ...SHELLS];

const flagWords = (): string[] => FLAGS.flatMap((f) => (f.short ? [f.long, f.short] : [f.long]));

/** zsh/POSIX single-quoted string. */
const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** fish single-quoted string (fish allows \' and \\ inside). */
const fq = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

function bash(): string {
  const cmds = NAMES.join(" ");
  const flags = flagWords().join(" ");
  return `# nps bash completion. Set up with: nps completions install
_nps() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}"
  COMPREPLY=()
  case "$prev" in
    --pm) COMPREPLY=( $(compgen -W "${PMS.join(" ")}" -- "$cur") ); return ;;
    ${VALUE_FLAGS.join("|")}) return ;;
  esac
  case "$cur" in
    -*) COMPREPLY=( $(compgen -W "${flags}" -- "$cur") ); return ;;
  esac
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${cmds}" -- "$cur") )
    return
  fi
  case "\${COMP_WORDS[1]}" in
    completions)
      if [ "$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=( $(compgen -W "${COMPLETIONS_ARGS.join(" ")}" -- "$cur") )
      elif [ "$COMP_CWORD" -eq 3 ] && [ "\${COMP_WORDS[2]}" = install ]; then
        COMPREPLY=( $(compgen -W "${SHELLS.join(" ")}" -- "$cur") )
      fi ;;
    help)
      [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=( $(compgen -W "${cmds}" -- "$cur") ) ;;
  esac
}
complete -F _nps nps
`;
}

function zsh(): string {
  const cmds = COMMANDS.map((cmd) => `    ${sq(`${cmd.name}:${cmd.summary}`)}`).join("\n");
  const flags = FLAGS.flatMap((f) =>
    [f.long, ...(f.short ? [f.short] : [])].map((n) => `    ${sq(`${n}:${f.summary}`)}`),
  ).join("\n");
  return `#compdef nps
# nps zsh completion. Set up with: nps completions install
_nps() {
  local -a cmds flags
  cmds=(
${cmds}
  )
  flags=(
${flags}
  )
  case $words[CURRENT-1] in
    --pm) compadd -- ${PMS.join(" ")}; return ;;
    ${VALUE_FLAGS.join("|")}) return ;;
  esac
  if [[ $PREFIX == -* ]]; then
    _describe -t flags 'nps flag' flags
    return
  fi
  if (( CURRENT == 2 )); then
    _describe -t commands 'nps command' cmds
    return
  fi
  case $words[2] in
    completions)
      if (( CURRENT == 3 )); then
        compadd -- ${COMPLETIONS_ARGS.join(" ")}
      elif (( CURRENT == 4 )) && [[ $words[3] == install ]]; then
        compadd -- ${SHELLS.join(" ")}
      fi ;;
    help)
      (( CURRENT == 3 )) && _describe -t commands 'nps command' cmds ;;
  esac
}
(( $+functions[compdef] )) || { autoload -Uz compinit && compinit; }
compdef _nps nps
`;
}

function fish(): string {
  const lines = [
    "# nps fish completion. Set up with: nps completions install",
    "complete -c nps -f",
    ...COMMANDS.map(
      (cmd) => `complete -c nps -n __fish_use_subcommand -a ${cmd.name} -d ${fq(cmd.summary)}`,
    ),
    `complete -c nps -n '__fish_seen_subcommand_from completions' -a ${fq(COMPLETIONS_ARGS.join(" "))}`,
    `complete -c nps -n '__fish_seen_subcommand_from help' -a ${fq(NAMES.join(" "))}`,
    ...FLAGS.map((f) => {
      const short = f.short ? ` -s ${f.short.slice(1)}` : "";
      const arg = f.values
        ? ` -x -a ${fq(f.values.join(" "))}`
        : VALUE_FLAGS.includes(f.long)
          ? " -x"
          : "";
      return `complete -c nps${short} -l ${f.long.slice(2)}${arg} -d ${fq(f.summary)}`;
    }),
  ];
  return lines.join("\n") + "\n";
}

export function completionScript(shell: Shell): string {
  if (shell === "bash") return bash();
  if (shell === "zsh") return zsh();
  return fish();
}

export function aliasSnippet(): string {
  return `# Route installs through nps. Add to your shell rc file.
alias ni='nps install'      # ni express   -> intel + confirm + install
alias nic='nps check'       # nic express  -> intel only, never installs
alias nscan='nps scan'      # nscan        -> screen this project's dependencies
`;
}
