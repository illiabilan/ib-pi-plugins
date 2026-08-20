#!/usr/bin/env bash
#
# Pi Plugins Installation Script
# Supports global installation (~/.pi/agent) and repository-local installation (<repo>/.pi)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# -----------------------------------------------------------------------------
# Color & UI Formatting
# -----------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD="\033[1m"
  DIM="\033[2m"
  RESET="\033[0m"
  RED="\033[31m"
  GREEN="\033[32m"
  YELLOW="\033[33m"
  BLUE="\033[34m"
  CYAN="\033[36m"
else
  BOLD=""
  DIM=""
  RESET=""
  RED=""
  GREEN=""
  YELLOW=""
  BLUE=""
  CYAN=""
fi

log_info() {
  if [ "$QUIET" = false ]; then
    printf "${CYAN}ℹ${RESET} %s\n" "$*"
  fi
}

log_success() {
  if [ "$QUIET" = false ]; then
    printf "${GREEN}✔${RESET} %s\n" "$*"
  fi
}

log_warn() {
  if [ "$QUIET" = false ]; then
    printf "${YELLOW}⚠${RESET} %s\n" "$*"
  fi
}

log_error() {
  printf "${RED}✖${RESET} %s\n" "$*" >&2
}

log_step() {
  if [ "$QUIET" = false ]; then
    printf "\n${BOLD}${BLUE}==>${RESET} ${BOLD}%s${RESET}\n" "$*"
  fi
}

log_dim() {
  if [ "$VERBOSE" = true ] && [ "$QUIET" = false ]; then
    printf "  ${DIM}%s${RESET}\n" "$*"
  fi
}

# -----------------------------------------------------------------------------
# Configuration Defaults
# -----------------------------------------------------------------------------
TARGET_SCOPE=""          # "global" or "local"
REPO_PATH=""             # Specified for local installs
TARGET_DIR=""            # Resolved base directory (~/.pi/agent or <repo>/.pi)
REPO_ROOT=""             # Root of git repo for local install
METHOD="symlink"         # "symlink" or "copy"
PRESET="all"             # "all", "recommended", "global", "bash-replacement", "typescript", "android", "core", "custom"

INSTALL_EXTENSIONS=true
INSTALL_SKILLS=true
INSTALL_AGENTS=true
INSTALL_PROMPTS=true

SELECTED_EXTENSIONS=()
SELECTED_SKILLS=()
SELECTED_AGENTS=()
SELECTED_PROMPTS=()

CUSTOM_EXTENSIONS_SET=false
CUSTOM_SKILLS_SET=false
CUSTOM_AGENTS_SET=false
CUSTOM_PROMPTS_SET=false

NPM_MODE="deps"          # "deps" (install only if dependencies exist), "all" (all package.json), "none" (skip)
GIT_EXCLUDE=true         # Add .pi/ to .git/info/exclude on local installs
DRY_RUN=false
UNINSTALL=false
FORCE=false
VERBOSE=false
QUIET=false
INTERACTIVE=false

# -----------------------------------------------------------------------------
# Discover Resources in Source Repository
# -----------------------------------------------------------------------------
discover_available_items() {
  ALL_EXTENSIONS=()
  if [ -d "$SCRIPT_DIR/extensions" ]; then
    while IFS= read -r item; do
      [ -n "$item" ] && ALL_EXTENSIONS+=("$item")
    done < <(find "$SCRIPT_DIR/extensions" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)
  fi

  ALL_SKILLS=()
  if [ -d "$SCRIPT_DIR/skills" ]; then
    while IFS= read -r item; do
      [ -n "$item" ] && ALL_SKILLS+=("$item")
    done < <(find "$SCRIPT_DIR/skills" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)
  fi

  ALL_AGENTS=()
  if [ -d "$SCRIPT_DIR/agents" ]; then
    while IFS= read -r item; do
      [ -n "$item" ] && ALL_AGENTS+=("$item")
    done < <(find "$SCRIPT_DIR/agents" -mindepth 1 -maxdepth 1 -name "*.md" -exec basename {} .md \; | sort)
  fi

  ALL_PROMPTS=()
  if [ -d "$SCRIPT_DIR/prompts" ]; then
    while IFS= read -r item; do
      [ -n "$item" ] && ALL_PROMPTS+=("$item")
    done < <(find "$SCRIPT_DIR/prompts" -mindepth 1 -maxdepth 1 -name "*.md" -exec basename {} .md \; | sort)
  fi
}

# -----------------------------------------------------------------------------
# Help & Documentation
# -----------------------------------------------------------------------------
show_help() {
  cat <<EOF
${BOLD}Pi Plugins Installer${RESET}
Install extensions, skills, agents, and prompts globally or into a target repository.

${BOLD}USAGE:${RESET}
  ./install.sh [TARGET] [OPTIONS]

${BOLD}TARGET OPTIONS:${RESET} (Choose one)
  ${CYAN}-g, --global${RESET}                Install globally into ~/.pi/agent
  ${CYAN}-l, --local <REPO_PATH>${RESET}     Install locally into <REPO_PATH>/.pi
  ${CYAN}-r, --repo <REPO_PATH>${RESET}      Alias for --local

${BOLD}INSTALLATION METHOD:${RESET}
  ${CYAN}-s, --link, --symlink${RESET}       Create symbolic links to this repo (default)
  ${CYAN}-c, --copy${RESET}                  Copy files instead of symlinking

${BOLD}PRESETS:${RESET}
  ${CYAN}-p, --preset <NAME>${RESET}         Choose a predefined plugin set:
      ${BOLD}all${RESET}                 All extensions, skills, agents, prompts (default)
      ${BOLD}recommended, global${RESET} Recommended global set (bash-replacements + core tools + skills + agents + prompts)
      ${BOLD}bash-replacement${RESET}    Pure bash-replacement tools (grep, list-files, git, file-ops, etc.)
      ${BOLD}typescript, ts${RESET}      TypeScript / Node tooling (node-project, pi-trace, gh, process)
      ${BOLD}android, gradle${RESET}     Android / Gradle tooling (gradle-build, archive-inspect, gh, process)
      ${BOLD}core${RESET}                Essential subset (code-search, subagent, bash-guardrail, token-stats, git, grep, list-files)

${BOLD}COMPONENT SELECTION:${RESET}
  ${CYAN}-a, --all${RESET}                   Install all components (default)
  ${CYAN}--extensions [LIST]${RESET}         Comma-separated list of extensions to install
  ${CYAN}--skills [LIST]${RESET}             Comma-separated list of skills to install
  ${CYAN}--agents [LIST]${RESET}             Comma-separated list of agents to install
  ${CYAN}--prompts [LIST]${RESET}            Comma-separated list of prompts to install
  ${CYAN}--no-extensions${RESET}             Skip all extensions
  ${CYAN}--no-skills${RESET}                 Skip all skills
  ${CYAN}--no-agents${RESET}                 Skip all agents
  ${CYAN}--no-prompts${RESET}                Skip all prompts

${BOLD}NPM DEPENDENCIES:${RESET}
  ${CYAN}--npm${RESET}                       Run npm install for extensions with dependencies (default)
  ${CYAN}--npm-all${RESET}                   Run npm install for all extensions with a package.json
  ${CYAN}--no-npm, --skip-npm${RESET}        Skip running npm install

${BOLD}REPOSITORY INTEGRATION:${RESET}
  ${CYAN}--git-exclude${RESET}               Add .pi/ to target repo's .git/info/exclude (default: yes)
  ${CYAN}--no-git-exclude${RESET}            Do not modify .git/info/exclude

${BOLD}OPERATIONS & FLAGS:${RESET}
  ${CYAN}-u, --uninstall${RESET}             Uninstall / remove plugins from the target location
  ${CYAN}--list${RESET}                      List available extensions, skills, agents, and prompts
  ${CYAN}-n, --dry-run${RESET}               Show actions without modifying files
  ${CYAN}-f, --force${RESET}                 Overwrite existing destinations without asking
  ${CYAN}-i, --interactive${RESET}           Launch interactive configuration wizard
  ${CYAN}-v, --verbose${RESET}               Enable verbose output
  ${CYAN}-q, --quiet${RESET}                 Minimal output (errors only)
  ${CYAN}-h, --help${RESET}                  Display this help message

${BOLD}EXAMPLES:${RESET}
  # Global installation (symlinks into ~/.pi/agent)
  ./install.sh --global

  # Local installation in a target repository
  ./install.sh --local /path/to/my-repo

  # Local installation with copy method and TypeScript preset
  ./install.sh --local /path/to/my-repo --copy --preset typescript

  # Install only specific extensions to the current repository
  ./install.sh --local . --extensions grep,list-files,code-search

  # Global install with recommended preset
  ./install.sh --global --preset recommended

  # Uninstall previously installed plugins from ~/.pi/agent
  ./install.sh --global --uninstall

  # Preview installation actions without executing
  ./install.sh --global --dry-run
EOF
}

# -----------------------------------------------------------------------------
# List Available Items
# -----------------------------------------------------------------------------
show_list() {
  discover_available_items
  printf "${BOLD}Available in %s:${RESET}\n\n" "$SCRIPT_DIR"

  printf "${BOLD}${CYAN}Extensions (${#ALL_EXTENSIONS[@]}):${RESET}\n"
  for item in "${ALL_EXTENSIONS[@]}"; do
    printf "  • %s\n" "$item"
  done

  printf "\n${BOLD}${CYAN}Skills (${#ALL_SKILLS[@]}):${RESET}\n"
  for item in "${ALL_SKILLS[@]}"; do
    printf "  • %s\n" "$item"
  done

  printf "\n${BOLD}${CYAN}Agents (${#ALL_AGENTS[@]}):${RESET}\n"
  for item in "${ALL_AGENTS[@]}"; do
    printf "  • %s\n" "$item"
  done

  printf "\n${BOLD}${CYAN}Prompts (${#ALL_PROMPTS[@]}):${RESET}\n"
  for item in "${ALL_PROMPTS[@]}"; do
    printf "  • %s\n" "$item"
  done

  printf "\n${BOLD}${CYAN}Presets:${RESET}\n"
  printf "  • ${BOLD}all${RESET}: All extensions, skills, agents, prompts\n"
  printf "  • ${BOLD}recommended / global${RESET}: Recommended global set (bash-replacements + core tools + skills + agents + prompts)\n"
  printf "  • ${BOLD}bash-replacement${RESET}: grep, list-files, git, file-ops, path-stats, diff, file-write-plus, env-info, bash-guardrail\n"
  printf "  • ${BOLD}typescript / ts${RESET}: node-project, pi-trace, gh, process\n"
  printf "  • ${BOLD}android / gradle${RESET}: gradle-build, archive-inspect, gh, process\n"
  printf "  • ${BOLD}core${RESET}: code-search, subagent, bash-guardrail, token-stats, git, grep, list-files\n"
}

# -----------------------------------------------------------------------------
# Argument Parsing
# -----------------------------------------------------------------------------
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -g|--global)
        TARGET_SCOPE="global"
        shift
        ;;
      -l|--local|-r|--repo)
        TARGET_SCOPE="local"
        if [ $# -lt 2 ] || [[ "$2" == -* ]]; then
          REPO_PATH="."
        else
          REPO_PATH="$2"
          shift
        fi
        shift
        ;;
      --local=*|--repo=*)
        TARGET_SCOPE="local"
        REPO_PATH="${1#*=}"
        shift
        ;;
      -s|--link|--symlink)
        METHOD="symlink"
        shift
        ;;
      -c|--copy)
        METHOD="copy"
        shift
        ;;
      -p|--preset)
        if [ $# -lt 2 ]; then
          log_error "Option '$1' requires a preset name (e.g. all, recommended, typescript, android)"
          exit 1
        fi
        PRESET="$2"
        shift 2
        ;;
      --preset=*)
        PRESET="${1#*=}"
        shift
        ;;
      -a|--all)
        PRESET="all"
        INSTALL_EXTENSIONS=true
        INSTALL_SKILLS=true
        INSTALL_AGENTS=true
        INSTALL_PROMPTS=true
        shift
        ;;
      --extensions)
        INSTALL_EXTENSIONS=true
        CUSTOM_EXTENSIONS_SET=true
        if [ $# -ge 2 ] && [[ "$2" != -* ]]; then
          IFS=',' read -r -a SELECTED_EXTENSIONS <<< "$2"
          shift
        fi
        shift
        ;;
      --extensions=*)
        INSTALL_EXTENSIONS=true
        CUSTOM_EXTENSIONS_SET=true
        IFS=',' read -r -a SELECTED_EXTENSIONS <<< "${1#*=}"
        shift
        ;;
      --extension)
        INSTALL_EXTENSIONS=true
        CUSTOM_EXTENSIONS_SET=true
        if [ $# -lt 2 ]; then
          log_error "Option '$1' requires an extension name"
          exit 1
        fi
        SELECTED_EXTENSIONS+=("$2")
        shift 2
        ;;
      --skills)
        INSTALL_SKILLS=true
        CUSTOM_SKILLS_SET=true
        if [ $# -ge 2 ] && [[ "$2" != -* ]]; then
          IFS=',' read -r -a SELECTED_SKILLS <<< "$2"
          shift
        fi
        shift
        ;;
      --skills=*)
        INSTALL_SKILLS=true
        CUSTOM_SKILLS_SET=true
        IFS=',' read -r -a SELECTED_SKILLS <<< "${1#*=}"
        shift
        ;;
      --agents)
        INSTALL_AGENTS=true
        CUSTOM_AGENTS_SET=true
        if [ $# -ge 2 ] && [[ "$2" != -* ]]; then
          IFS=',' read -r -a SELECTED_AGENTS <<< "$2"
          shift
        fi
        shift
        ;;
      --agents=*)
        INSTALL_AGENTS=true
        CUSTOM_AGENTS_SET=true
        IFS=',' read -r -a SELECTED_AGENTS <<< "${1#*=}"
        shift
        ;;
      --prompts)
        INSTALL_PROMPTS=true
        CUSTOM_PROMPTS_SET=true
        if [ $# -ge 2 ] && [[ "$2" != -* ]]; then
          IFS=',' read -r -a SELECTED_PROMPTS <<< "$2"
          shift
        fi
        shift
        ;;
      --prompts=*)
        INSTALL_PROMPTS=true
        CUSTOM_PROMPTS_SET=true
        IFS=',' read -r -a SELECTED_PROMPTS <<< "${1#*=}"
        shift
        ;;
      --no-extensions)
        INSTALL_EXTENSIONS=false
        shift
        ;;
      --no-skills)
        INSTALL_SKILLS=false
        shift
        ;;
      --no-agents)
        INSTALL_AGENTS=false
        shift
        ;;
      --no-prompts)
        INSTALL_PROMPTS=false
        shift
        ;;
      --npm)
        NPM_MODE="deps"
        shift
        ;;
      --npm-all)
        NPM_MODE="all"
        shift
        ;;
      --no-npm|--skip-npm)
        NPM_MODE="none"
        shift
        ;;
      --git-exclude)
        GIT_EXCLUDE=true
        shift
        ;;
      --no-git-exclude)
        GIT_EXCLUDE=false
        shift
        ;;
      -u|--uninstall)
        UNINSTALL=true
        shift
        ;;
      -n|--dry-run)
        DRY_RUN=true
        shift
        ;;
      -f|--force)
        FORCE=true
        shift
        ;;
      -i|--interactive)
        INTERACTIVE=true
        shift
        ;;
      -v|--verbose)
        VERBOSE=true
        shift
        ;;
      -q|--quiet)
        QUIET=true
        shift
        ;;
      --list)
        show_list
        exit 0
        ;;
      -h|--help)
        show_help
        exit 0
        ;;
      *)
        log_error "Unknown option: $1"
        printf "Run '%s --help' for usage instructions.\n" "$0" >&2
        exit 1
        ;;
    esac
  done
}

# -----------------------------------------------------------------------------
# Interactive Wizard
# -----------------------------------------------------------------------------
run_interactive_wizard() {
  printf "\n${BOLD}${CYAN}╔══════════════════════════════════════════════════════════╗${RESET}\n"
  printf "${BOLD}${CYAN}║              Pi Plugins Installation Wizard              ║${RESET}\n"
  printf "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════╝${RESET}\n\n"

  # 1. Target scope
  if [ -z "$TARGET_SCOPE" ]; then
    printf "${BOLD}Select installation target:${RESET}\n"
    printf "  1) ${GREEN}Global${RESET} (~/.pi/agent) — available across all projects\n"
    printf "  2) ${CYAN}Local${RESET} (in a specific repository's .pi directory)\n"
    printf "Choice [1-2, default: 1]: "
    read -r choice_target
    case "$choice_target" in
      2)
        TARGET_SCOPE="local"
        printf "Enter target repository path [default: .]: "
        read -r input_path
        REPO_PATH="${input_path:-.}"
        ;;
      *)
        TARGET_SCOPE="global"
        ;;
    esac
  fi

  # 2. Method
  printf "\n${BOLD}Select installation method:${RESET}\n"
  printf "  1) ${GREEN}Symlink${RESET} (recommended — stays synced with updates in this repo)\n"
  printf "  2) ${CYAN}Copy${RESET} (standalone files)\n"
  printf "Choice [1-2, default: 1]: "
  read -r choice_method
  case "$choice_method" in
    2) METHOD="copy" ;;
    *) METHOD="symlink" ;;
  esac

  # 3. Preset
  printf "\n${BOLD}Select plugin preset:${RESET}\n"
  printf "  1) ${GREEN}All${RESET} (Everything: all extensions, skills, agents, prompts)\n"
  printf "  2) ${CYAN}Recommended / Global Set${RESET} (General-purpose tools & skills)\n"
  printf "  3) ${CYAN}TypeScript / Node Tools${RESET} (node-project, pi-trace, gh, process)\n"
  printf "  4) ${CYAN}Android / Gradle Tools${RESET} (gradle-build, archive-inspect, gh, process)\n"
  printf "  5) ${CYAN}Bash-Replacement Set Only${RESET}\n"
  printf "Choice [1-5, default: 1]: "
  read -r choice_preset
  case "$choice_preset" in
    2) PRESET="recommended" ;;
    3) PRESET="typescript" ;;
    4) PRESET="android" ;;
    5) PRESET="bash-replacement" ;;
    *) PRESET="all" ;;
  esac

  # 4. Git exclude for local
  if [ "$TARGET_SCOPE" = "local" ]; then
    printf "\n${BOLD}Add .pi/ to target repository's .git/info/exclude?${RESET} [Y/n]: "
    read -r choice_git
    case "$choice_git" in
      [nN]*) GIT_EXCLUDE=false ;;
      *) GIT_EXCLUDE=true ;;
    esac
  fi

  printf "\n"
}

# -----------------------------------------------------------------------------
# Target Directory Resolution
# -----------------------------------------------------------------------------
resolve_target() {
  if [ "$TARGET_SCOPE" = "global" ]; then
    TARGET_DIR="${PI_AGENT_DIR:-${PI_CONFIG_DIR:-$HOME/.pi/agent}}"
    REPO_ROOT=""
  elif [ "$TARGET_SCOPE" = "local" ]; then
    if [ -z "$REPO_PATH" ]; then
      REPO_PATH="."
    fi

    # Expand leading ~
    REPO_PATH="${REPO_PATH/#\~/$HOME}"

    if [ ! -d "$REPO_PATH" ]; then
      if [ "$DRY_RUN" = true ]; then
        log_warn "Target directory '$REPO_PATH' does not exist (dry-run will assume creation)."
        REPO_DIR="$(mkdir -p "$REPO_PATH" 2>/dev/null && cd "$REPO_PATH" && pwd -P || echo "$REPO_PATH")"
      else
        if [ "$FORCE" = true ]; then
          mkdir -p "$REPO_PATH"
          REPO_DIR="$(cd "$REPO_PATH" && pwd -P)"
        else
          printf "${YELLOW}Directory '%s' does not exist. Create it?${RESET} [Y/n]: " "$REPO_PATH"
          read -r create_ans
          case "$create_ans" in
            [nN]*)
              log_error "Aborted: target repository directory does not exist."
              exit 1
              ;;
            *)
              mkdir -p "$REPO_PATH"
              REPO_DIR="$(cd "$REPO_PATH" && pwd -P)"
              ;;
          esac
        fi
      fi
    else
      REPO_DIR="$(cd "$REPO_PATH" && pwd -P)"
    fi

    # Check if target is already ending with .pi
    if [[ "$(basename "$REPO_DIR")" == ".pi" ]]; then
      TARGET_DIR="$REPO_DIR"
      REPO_ROOT="$(dirname "$REPO_DIR")"
    else
      TARGET_DIR="$REPO_DIR/.pi"
      REPO_ROOT="$REPO_DIR"
    fi
  else
    log_error "Target scope must be specified (--global or --local <repo_path>)."
    printf "Run '%s --help' for usage instructions.\n" "$0" >&2
    exit 1
  fi
}

# -----------------------------------------------------------------------------
# Preset & Selection Resolution
# -----------------------------------------------------------------------------
resolve_selected_items() {
  discover_available_items

  # If custom selections were not provided, resolve based on PRESET
  if [ "$CUSTOM_EXTENSIONS_SET" = false ]; then
    case "$PRESET" in
      all)
        SELECTED_EXTENSIONS=("${ALL_EXTENSIONS[@]}")
        ;;
      recommended|global|global-recommended)
        local rec=(
          "grep" "list-files" "git" "file-ops" "path-stats" "diff"
          "file-write-plus" "env-info" "bash-guardrail" "code-search"
          "active-subagents-widget" "code_viewer" "multi-file-read"
          "subagent" "token-stats" "jira"
        )
        SELECTED_EXTENSIONS=()
        for item in "${rec[@]}"; do
          if [ -d "$SCRIPT_DIR/extensions/$item" ]; then
            SELECTED_EXTENSIONS+=("$item")
          fi
        done
        ;;
      bash-replacement)
        local bash_rep=(
          "grep" "list-files" "git" "file-ops" "path-stats" "diff"
          "file-write-plus" "env-info" "bash-guardrail"
        )
        SELECTED_EXTENSIONS=()
        for item in "${bash_rep[@]}"; do
          if [ -d "$SCRIPT_DIR/extensions/$item" ]; then
            SELECTED_EXTENSIONS+=("$item")
          fi
        done
        INSTALL_SKILLS=false
        INSTALL_AGENTS=false
        INSTALL_PROMPTS=false
        ;;
      typescript|ts|node)
        local ts_set=("node-project" "pi-trace" "gh" "process")
        SELECTED_EXTENSIONS=()
        for item in "${ts_set[@]}"; do
          if [ -d "$SCRIPT_DIR/extensions/$item" ]; then
            SELECTED_EXTENSIONS+=("$item")
          fi
        done
        INSTALL_SKILLS=false
        INSTALL_AGENTS=false
        INSTALL_PROMPTS=false
        ;;
      android|gradle|jvm)
        local android_set=("gradle-build" "archive-inspect" "gh" "process")
        SELECTED_EXTENSIONS=()
        for item in "${android_set[@]}"; do
          if [ -d "$SCRIPT_DIR/extensions/$item" ]; then
            SELECTED_EXTENSIONS+=("$item")
          fi
        done
        INSTALL_SKILLS=false
        INSTALL_AGENTS=false
        INSTALL_PROMPTS=false
        ;;
      core)
        local core_set=("code-search" "subagent" "bash-guardrail" "token-stats" "git" "grep" "list-files")
        SELECTED_EXTENSIONS=()
        for item in "${core_set[@]}"; do
          if [ -d "$SCRIPT_DIR/extensions/$item" ]; then
            SELECTED_EXTENSIONS+=("$item")
          fi
        done
        ;;
      *)
        log_warn "Unknown preset '$PRESET', defaulting to all."
        SELECTED_EXTENSIONS=("${ALL_EXTENSIONS[@]}")
        ;;
    esac
  fi

  if [ "$CUSTOM_SKILLS_SET" = false ]; then
    if [ "$INSTALL_SKILLS" = true ]; then
      SELECTED_SKILLS=("${ALL_SKILLS[@]}")
    else
      SELECTED_SKILLS=()
    fi
  fi

  if [ "$CUSTOM_AGENTS_SET" = false ]; then
    if [ "$INSTALL_AGENTS" = true ]; then
      SELECTED_AGENTS=("${ALL_AGENTS[@]}")
    else
      SELECTED_AGENTS=()
    fi
  fi

  if [ "$CUSTOM_PROMPTS_SET" = false ]; then
    if [ "$INSTALL_PROMPTS" = true ]; then
      SELECTED_PROMPTS=("${ALL_PROMPTS[@]}")
    else
      SELECTED_PROMPTS=()
    fi
  fi

  # Filter out items if component is disabled
  if [ "$INSTALL_EXTENSIONS" = false ]; then SELECTED_EXTENSIONS=(); fi
  if [ "$INSTALL_SKILLS" = false ]; then SELECTED_SKILLS=(); fi
  if [ "$INSTALL_AGENTS" = false ]; then SELECTED_AGENTS=(); fi
  if [ "$INSTALL_PROMPTS" = false ]; then SELECTED_PROMPTS=(); fi
}

# -----------------------------------------------------------------------------
# NPM Dependency Management
# -----------------------------------------------------------------------------
check_extension_has_dependencies() {
  local ext_dir="$1"
  local pkg_file="$ext_dir/package.json"

  if [ ! -f "$pkg_file" ]; then
    return 1
  fi

  if [ "$NPM_MODE" = "all" ]; then
    return 0
  fi

  if [ "$NPM_MODE" = "none" ]; then
    return 1
  fi

  # NPM_MODE = "deps": check if package.json has non-empty "dependencies" field
  if command -v node >/dev/null 2>&1; then
    node -e '
      try {
        const pkg = require(process.argv[1]);
        if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
          process.exit(0);
        }
      } catch(e) {}
      process.exit(1);
    ' "$pkg_file" 2>/dev/null
    return $?
  else
    if grep -q '"dependencies"' "$pkg_file"; then
      return 0
    else
      return 1
    fi
  fi
}

handle_npm_for_extension() {
  local ext_name="$1"
  local ext_source="$SCRIPT_DIR/extensions/$ext_name"
  local ext_target="$TARGET_DIR/extensions/$ext_name"

  if [ "$NPM_MODE" = "none" ]; then
    return 0
  fi

  local install_dir=""
  if [ "$METHOD" = "symlink" ]; then
    install_dir="$ext_source"
  else
    install_dir="$ext_target"
  fi

  if check_extension_has_dependencies "$ext_source"; then
    # If symlinking and node_modules already exists and non-empty, skip unless forced
    if [ "$METHOD" = "symlink" ] && [ -d "$ext_source/node_modules" ] && [ "$FORCE" = false ]; then
      log_dim "npm dependencies already present in $ext_source"
      return 0
    fi

    if ! command -v npm >/dev/null 2>&1; then
      log_warn "npm command not found; cannot install dependencies for extension '$ext_name'."
      return 0
    fi

    if [ "$DRY_RUN" = true ]; then
      log_info "[dry-run] Would run 'npm install' in $install_dir"
      return 0
    fi

    log_info "Installing npm dependencies for extension '$ext_name'..."
    if (cd "$install_dir" && npm install --omit=dev --silent 2>&1 >/dev/null); then
      log_success "npm dependencies installed for '$ext_name'"
    else
      if (cd "$install_dir" && npm install --silent 2>&1 >/dev/null); then
        log_success "npm dependencies installed for '$ext_name'"
      else
        log_warn "npm install encountered issues in $install_dir"
      fi
    fi
  fi
}

# -----------------------------------------------------------------------------
# File Installation Functions
# -----------------------------------------------------------------------------
install_entry() {
  local src="$1"
  local dest="$2"
  local item_label="$3"

  local dest_parent
  dest_parent="$(dirname "$dest")"

  if [ "$DRY_RUN" = true ]; then
    if [ "$METHOD" = "symlink" ]; then
      log_info "[dry-run] Link: $dest -> $src"
    else
      log_info "[dry-run] Copy: $src -> $dest"
    fi
    return 0
  fi

  mkdir -p "$dest_parent"

  if [ -L "$dest" ] || [ -e "$dest" ]; then
    rm -rf "$dest"
  fi

  if [ "$METHOD" = "symlink" ]; then
    ln -s "$src" "$dest"
    log_dim "Linked: $dest -> $src"
  else
    if [ -d "$src" ]; then
      cp -R "$src" "$dest"
    else
      cp -f "$src" "$dest"
    fi
    log_dim "Copied: $src -> $dest"
  fi
}

uninstall_entry() {
  local dest="$1"
  local item_label="$2"

  if [ "$DRY_RUN" = true ]; then
    if [ -L "$dest" ] || [ -e "$dest" ]; then
      log_info "[dry-run] Remove: $dest"
    fi
    return 0
  fi

  if [ -L "$dest" ] || [ -e "$dest" ]; then
    rm -rf "$dest"
    log_dim "Removed: $dest"
  fi
}

# -----------------------------------------------------------------------------
# Git Exclude Configuration
# -----------------------------------------------------------------------------
handle_git_exclude() {
  if [ "$TARGET_SCOPE" != "local" ] || [ "$GIT_EXCLUDE" != true ] || [ -z "$REPO_ROOT" ]; then
    return 0
  fi

  local git_dir="$REPO_ROOT/.git"
  if [ ! -d "$git_dir" ]; then
    return 0
  fi

  local exclude_file="$git_dir/info/exclude"

  if [ "$DRY_RUN" = true ]; then
    log_info "[dry-run] Would ensure '.pi/' is listed in $exclude_file"
    return 0
  fi

  mkdir -p "$git_dir/info"

  if [ -f "$exclude_file" ] && grep -Eq '^(\.pi/|\.pi)$' "$exclude_file" 2>/dev/null; then
    log_dim ".pi/ already excluded in $exclude_file"
  else
    {
      printf "\n# Pi agent project-local configuration & extensions\n.pi/\n"
    } >> "$exclude_file"
    log_success "Added .pi/ to $exclude_file"
  fi
}

# -----------------------------------------------------------------------------
# Execution Summary & Confirmation
# -----------------------------------------------------------------------------
print_plan() {
  log_step "Installation Configuration"
  printf "  • ${BOLD}Target:${RESET}      %s (%s)\n" "$TARGET_DIR" "$TARGET_SCOPE"
  printf "  • ${BOLD}Method:${RESET}      %s\n" "$METHOD"
  printf "  • ${BOLD}Preset:${RESET}      %s\n" "$PRESET"
  if [ "$TARGET_SCOPE" = "local" ] && [ -n "$REPO_ROOT" ]; then
    printf "  • ${BOLD}Git Exclude:${RESET} %s\n" "$([ "$GIT_EXCLUDE" = true ] && echo "yes (.git/info/exclude)" || echo "no")"
  fi
  printf "  • ${BOLD}NPM Mode:${RESET}    %s\n" "$NPM_MODE"

  log_step "Selected Components"
  if [ ${#SELECTED_EXTENSIONS[@]} -gt 0 ]; then
    local ext_str
    ext_str="$(IFS=, ; echo "${SELECTED_EXTENSIONS[*]}")"
    printf "  • Extensions (%d): %s\n" "${#SELECTED_EXTENSIONS[@]}" "$ext_str"
  else
    printf "  • Extensions (0):  none\n"
  fi

  if [ ${#SELECTED_SKILLS[@]} -gt 0 ]; then
    local skill_str
    skill_str="$(IFS=, ; echo "${SELECTED_SKILLS[*]}")"
    printf "  • Skills     (%d): %s\n" "${#SELECTED_SKILLS[@]}" "$skill_str"
  else
    printf "  • Skills     (0):  none\n"
  fi

  if [ ${#SELECTED_AGENTS[@]} -gt 0 ]; then
    local agent_str
    agent_str="$(IFS=, ; echo "${SELECTED_AGENTS[*]}")"
    printf "  • Agents     (%d): %s\n" "${#SELECTED_AGENTS[@]}" "$agent_str"
  else
    printf "  • Agents     (0):  none\n"
  fi

  if [ ${#SELECTED_PROMPTS[@]} -gt 0 ]; then
    local prompt_str
    prompt_str="$(IFS=, ; echo "${SELECTED_PROMPTS[*]}")"
    printf "  • Prompts    (%d): %s\n" "${#SELECTED_PROMPTS[@]}" "$prompt_str"
  else
    printf "  • Prompts    (0):  none\n"
  fi

  if [ "$DRY_RUN" = true ]; then
    printf "\n${YELLOW}${BOLD}DRY RUN MODE ENABLED — No files will be modified.${RESET}\n"
  fi
}

# -----------------------------------------------------------------------------
# Main Execution Flow
# -----------------------------------------------------------------------------
main() {
  parse_args "$@"

  # If no arguments provided in interactive terminal, prompt user
  if [ $# -eq 0 ] && [ -t 0 ] && [ -t 1 ]; then
    INTERACTIVE=true
  fi

  if [ "$INTERACTIVE" = true ]; then
    run_interactive_wizard
  fi

  # Resolve target directory and selections
  resolve_target
  resolve_selected_items

  if [ "$UNINSTALL" = true ]; then
    log_step "Uninstalling Plugins from $TARGET_DIR"

    local total_removed=0

    # Uninstall extensions
    for ext in "${SELECTED_EXTENSIONS[@]}"; do
      local dest="$TARGET_DIR/extensions/$ext"
      if [ -e "$dest" ] || [ -L "$dest" ]; then
        uninstall_entry "$dest" "extension $ext"
        total_removed=$((total_removed + 1))
      fi
    done

    # Uninstall skills
    for skill in "${SELECTED_SKILLS[@]}"; do
      local dest="$TARGET_DIR/skills/$skill"
      if [ -e "$dest" ] || [ -L "$dest" ]; then
        uninstall_entry "$dest" "skill $skill"
        total_removed=$((total_removed + 1))
      fi
    done

    # Uninstall agents
    for agent in "${SELECTED_AGENTS[@]}"; do
      local dest="$TARGET_DIR/agents/$agent.md"
      if [ -e "$dest" ] || [ -L "$dest" ]; then
        uninstall_entry "$dest" "agent $agent"
        total_removed=$((total_removed + 1))
      fi
    done

    # Uninstall prompts
    for prompt in "${SELECTED_PROMPTS[@]}"; do
      local dest="$TARGET_DIR/prompts/$prompt.md"
      if [ -e "$dest" ] || [ -L "$dest" ]; then
        uninstall_entry "$dest" "prompt $prompt"
        total_removed=$((total_removed + 1))
      fi
    done

    log_success "Uninstallation completed ($total_removed components removed)."
    exit 0
  fi

  print_plan

  # Installation Execution
  log_step "Installing Plugins"

  local ext_count=0
  local skill_count=0
  local agent_count=0
  local prompt_count=0

  # 1. Install Extensions
  if [ ${#SELECTED_EXTENSIONS[@]} -gt 0 ]; then
    for ext in "${SELECTED_EXTENSIONS[@]}"; do
      local src="$SCRIPT_DIR/extensions/$ext"
      local dest="$TARGET_DIR/extensions/$ext"

      if [ ! -d "$src" ]; then
        log_warn "Extension '$ext' not found in $SCRIPT_DIR/extensions, skipping."
        continue
      fi

      install_entry "$src" "$dest" "extension $ext"
      handle_npm_for_extension "$ext"
      ext_count=$((ext_count + 1))
    done
  fi

  # 2. Install Skills
  if [ ${#SELECTED_SKILLS[@]} -gt 0 ]; then
    for skill in "${SELECTED_SKILLS[@]}"; do
      local src="$SCRIPT_DIR/skills/$skill"
      local dest="$TARGET_DIR/skills/$skill"

      if [ ! -d "$src" ]; then
        log_warn "Skill '$skill' not found in $SCRIPT_DIR/skills, skipping."
        continue
      fi

      install_entry "$src" "$dest" "skill $skill"
      skill_count=$((skill_count + 1))
    done
  fi

  # 3. Install Agents
  if [ ${#SELECTED_AGENTS[@]} -gt 0 ]; then
    for agent in "${SELECTED_AGENTS[@]}"; do
      local src="$SCRIPT_DIR/agents/$agent.md"
      local dest="$TARGET_DIR/agents/$agent.md"

      if [ ! -f "$src" ]; then
        log_warn "Agent '$agent.md' not found in $SCRIPT_DIR/agents, skipping."
        continue
      fi

      install_entry "$src" "$dest" "agent $agent"
      agent_count=$((agent_count + 1))
    done
  fi

  # 4. Install Prompts
  if [ ${#SELECTED_PROMPTS[@]} -gt 0 ]; then
    for prompt in "${SELECTED_PROMPTS[@]}"; do
      local src="$SCRIPT_DIR/prompts/$prompt.md"
      local dest="$TARGET_DIR/prompts/$prompt.md"

      if [ ! -f "$src" ]; then
        log_warn "Prompt '$prompt.md' not found in $SCRIPT_DIR/prompts, skipping."
        continue
      fi

      install_entry "$src" "$dest" "prompt $prompt"
      prompt_count=$((prompt_count + 1))
    done
  fi

  # 5. Handle Git Exclude
  handle_git_exclude

  # Completion message
  log_step "Installation Complete"
  log_success "Successfully installed $ext_count extensions, $skill_count skills, $agent_count agents, and $prompt_count prompts into $TARGET_DIR"

  if [ "$TARGET_SCOPE" = "local" ]; then
    log_info "Note: Project-local extensions will be active when running pi in '$REPO_ROOT' (ensure the project is trusted)."
  else
    log_info "Note: Global plugins are active in all sessions. Reload during a session with '/reload'."
  fi
}

main "$@"
