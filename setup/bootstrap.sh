#!/usr/bin/env bash
# bootstrap.sh: install this repo's generic setup (plus the private overlay, if one is found) onto the current machine ($HOME).
# Idempotent and safe to re-run (loaded jobs with identical plists, and installed plugins, are skipped). Backs up any file it would overwrite to ~/.machine-setup-backup/<ts>/.
#   ./bootstrap.sh --dry-run      show what would happen, change nothing
#   ./bootstrap.sh                install
# Flags: --no-repos  --all-repos (also clone big optional upstream repos)  --launchd (install launchd jobs)  --no-plugins
# Overlay: MACHINE_SETUP_PRIVATE=<dir> (else ../machine-setup-private; "none" disables). See OVERLAY.md.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"   # setup/
REPO="$(cd "$ROOT/.." && pwd)"           # public repo root (claude/, launchd/, ...)
DRY=0; REPOS=1; ALLREPOS=0; LAUNCHD=0; PLUGINS=1
for a in "$@"; do case "$a" in
  --dry-run|-n) DRY=1;; --no-repos) REPOS=0;; --all-repos) ALLREPOS=1;;
  --launchd) LAUNCHD=1;; --no-plugins) PLUGINS=0;;
  -h|--help) sed -n '2,7p' "$0"; exit 0;; *) echo "unknown flag: $a" >&2; exit 2;; esac; done

# shellcheck source=lib/overlay.sh
. "$ROOT/lib/overlay.sh"
ms_resolve_overlay
ms_load_config

H="$HOME"; C="$H/.claude"; TS="$(date +%Y%m%d-%H%M%S)"; BK="$H/.machine-setup-backup/$TS"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
EFF="$TMP/eff"; mkdir -p "$EFF/claude"
ERR=0; SKIPPED=(); TODO=()
say()  { printf '%s\n' "$*"; }
act()  { if [ $DRY -eq 1 ]; then say "  [dry-run] $*"; else say "  $*"; fi; }
warn() { say "  WARN: $*"; }
doit() { [ $DRY -eq 1 ] && return 0; "$@"; }
esc()  { printf '%s' "$1" | sed 's/[\\&|]/\\&/g'; }

# render SRC OUT: substitute placeholders (spec 11.5); __SECRET:..__ is never touched
render_to() {
  local args=(-e "s|__HOME__|$(esc "$H")|g" -e "s|__LABEL_PREFIX__|$(esc "$LP")|g" -e "s|__REPO__|$(esc "$REPO")|g")
  [ -n "$OVERLAY" ] && args+=(-e "s|__OVERLAY__|$(esc "$OVERLAY")|g")
  sed "${args[@]}" "$1" > "$2"
}
render_str() {
  local args=(-e "s|__HOME__|$(esc "$H")|g" -e "s|__LABEL_PREFIX__|$(esc "$LP")|g" -e "s|__REPO__|$(esc "$REPO")|g")
  [ -n "$OVERLAY" ] && args+=(-e "s|__OVERLAY__|$(esc "$OVERLAY")|g")
  printf '%s' "$1" | sed "${args[@]}"
}

backup() {  # backup existing $1 into $BK, preserving the path relative to $HOME
  [ -e "$1" ] || [ -L "$1" ] || return 0
  local rel="${1#$H/}"
  if [ $DRY -eq 0 ]; then mkdir -p "$BK/$(dirname "$rel")"; cp -pPR "$1" "$BK/$rel"; fi
}
# render_checked SRC OUT WHAT: render, then detect a leftover __OVERLAY__ (skip) or unresolved placeholder (warn).
# returns 0 ok, 1 skipped (needs overlay), 2 unresolved placeholder
render_checked() {
  local src="$1" out="$2" what="$3" tok
  if grep -Iq -e '__' "$src" 2>/dev/null; then render_to "$src" "$out"; else cp "$src" "$out"; fi
  if grep -Iq -e '__OVERLAY__' "$out" 2>/dev/null; then return 1; fi
  tok="$(grep -Iho -E '__[A-Z][A-Z0-9_]*__' "$out" 2>/dev/null | head -1)"
  if [ -n "$tok" ]; then warn "unresolved placeholder $tok in $what"; ERR=1; return 2; fi
  return 0
}
# install_file SRC DEST : render, skip if identical, back up otherwise
install_file() {
  local src="$1" dest="$2" out="$TMP/render.$$" rc
  render_checked "$src" "$out" "${dest#$H/}"; rc=$?
  if [ $rc -eq 1 ]; then act "SKIP     ${dest#$H/}  (needs a private overlay; none configured)"; SKIPPED+=("needs overlay: ${dest#$H/}"); return 0; fi
  [ $rc -eq 2 ] && return 0
  if [ -f "$dest" ] && [ ! -L "$dest" ] && cmp -s "$out" "$dest"; then act "unchanged  ${dest#$H/}"; return 0; fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then act "overwrite (backup) ${dest#$H/}"; backup "$dest"; else act "install    ${dest#$H/}"; fi
  if [ $DRY -eq 0 ]; then
    mkdir -p "$(dirname "$dest")"
    [ -L "$dest" ] && rm -f "$dest"
    cp "$out" "$dest"; chmod "$(stat -f %Lp "$src")" "$dest"
  fi
}
# link_to TARGET LINKPATH
link_to() {
  local tgt="$1" lnk="$2"
  if [ -L "$lnk" ] && [ "$(readlink "$lnk")" = "$tgt" ]; then return 0; fi
  if [ -e "$lnk" ] || [ -L "$lnk" ]; then act "relink (backup) ${lnk#$H/} -> $tgt"; backup "$lnk"; else act "symlink    ${lnk#$H/} -> $tgt"; fi
  if [ $DRY -eq 0 ]; then mkdir -p "$(dirname "$lnk")"; rm -rf "$lnk"; ln -s "$tgt" "$lnk"; fi
}
# merge_tsv PUBLIC OVERLAY OUT: concatenate, overlay row wins on equal first column, C-locale sort
merge_tsv() {
  local f
  : > "$3"
  for f in "$1" "$2"; do [ -f "$f" ] && { cat "$f"; printf '\n'; }; done \
    | awk -F'\t' 'NF>0 && $0 !~ /^#/ {r[$1]=$0} END{for(k in r) print r[k]}' | LC_ALL=C sort -t "$(printf '\t')" -k1,1 > "$3"
}
# copy_claude SRC_CLAUDE_DIR: copy into $EFF/claude applying the .template name mapping
copy_claude() {
  local f rel dir base nb
  [ -d "$1" ] || return 0
  while IFS= read -r -d '' f; do
    rel="${f#$1/}"; dir="$(dirname "$rel")"; base="$(basename "$rel")"; nb="$base"
    case "$base" in
      *.template.md) continue;;
      *.template) nb="${base%.template}";;
      *.template.*) nb="${base/.template./.}";;
    esac
    if [ "$dir" = . ]; then rel="$nb"; else rel="$dir/$nb"; fi
    mkdir -p "$EFF/claude/$(dirname "$rel")"; cp -p "$f" "$EFF/claude/$rel"
  done < <(find "$1" -type f -not -name .DS_Store -print0 | LC_ALL=C sort -z)
}

# ---- build the effective (merged, not yet rendered) tree in $EFF
OV_CLAUDE="$TMP/no-overlay-claude"; [ -n "$OVERLAY" ] && OV_CLAUDE="$OVERLAY/claude"
copy_claude "$REPO/claude"; copy_claude "$OV_CLAUDE"
rm -f "$EFF/claude/settings.json"
TPL_SET="$REPO/claude/settings.template.json"; [ -f "$TPL_SET" ] || TPL_SET="$REPO/claude/settings.json"
python3 "$ROOT/lib/merge_settings.py" "$TPL_SET" "$OV_CLAUDE/settings.json" "$EFF/claude/settings.json" || { echo "settings merge failed" >&2; exit 2; }
python3 "$ROOT/lib/merge_plugins.py" "$REPO/claude/plugins.json" "$OV_CLAUDE/plugins.json" "$EFF/claude/plugins.json" || { echo "plugins merge failed" >&2; exit 2; }
for t in hook-deps skills.links commands.links; do merge_tsv "$REPO/claude/$t.tsv" "$OV_CLAUDE/$t.tsv" "$EFF/claude/$t.tsv"; done
{ cat "$REPO/claude/placeholders.txt" "$OV_CLAUDE/placeholders.txt" 2>/dev/null || true; } | grep . | LC_ALL=C sort -u > "$EFF/claude/placeholders.txt" || true
OVAG="$TMP/no-overlay-agents"; [ -n "$OVERLAY" ] && OVAG="$OVERLAY/agents"
if [ -d "$REPO/agents" ] || [ -d "$OVAG" ]; then
  mkdir -p "$EFF/agents/skills"
  for d in "$REPO/agents" "$OVAG"; do
    [ -d "$d/skills" ] && rsync -a "$d/skills/" "$EFF/agents/skills/"
    for lf in skill-lock.json skills-lock.json; do [ -f "$d/$lf" ] && cp "$d/$lf" "$EFF/agents/$lf"; done
  done
fi
OREPOS=""; [ -n "$OVERLAY" ] && [ -f "$OVERLAY/repos.tsv" ] && OREPOS="$OVERLAY/repos.tsv"

say "machine-setup bootstrap  HOME=$H  $([ $DRY -eq 1 ] && echo '(DRY RUN)')"
if [ -n "$OVERLAY" ]; then say "  overlay: $OVERLAY"; else say "  overlay: none (generic install)"; fi

say; say "== 1. prerequisites (see PREREQS.md)"
for b in git python3 claude node npx gh ccusage jq rsync; do
  if command -v "$b" >/dev/null 2>&1; then say "  ok       $b"; else warn "missing  $b  (install per PREREQS.md)"; fi
done

say; say "== 2. runtime directories"
DIRS=("$H/.local/state/claude-handoffs" "$C/hooks" "$C/skills" "$C/commands" "$H/.local/state/token-budget" "$H/.local/state/machine-setup" "$H/Library/LaunchAgents" "$H/.agents/skills")
if [ -n "$OVERLAY" ] && [ -f "$OVERLAY/dirs.txt" ]; then
  while IFS= read -r d || [ -n "$d" ]; do
    d="${d%$'\r'}"; case "$d" in ''|'#'*) continue;; esac
    d="${d//__HOME__/$H}"; case "$d" in /*) ;; *) d="$H/$d";; esac
    DIRS+=("$d")
  done < "$OVERLAY/dirs.txt"
fi
for d in "${DIRS[@]}"; do
  [ -d "$d" ] && continue; act "mkdir -p ${d#$H/}"; doit mkdir -p "$d"
done
[ $DRY -eq 0 ] && chmod 700 "$H/.local/state/token-budget"

say; say "== 3. repositories (overlay repos.tsv)"
if [ $REPOS -eq 0 ]; then say "  skipped (--no-repos)"
elif [ -z "$OREPOS" ]; then say "  skipped (no overlay repos.tsv)"
else
  while IFS=$'\t' read -r p kind origin branch main; do
    [ -n "$p" ] || continue; dest="${p//__HOME__/$H}"; name="$(basename "$dest")"
    case "$kind" in
      worktree) continue;;
      local-only) if [ -e "$dest/.git" ]; then continue; fi; SKIPPED+=("local-only, not recoverable: $name"); continue;;
    esac
    if [ -e "$dest/.git" ]; then say "  present  $name"; continue; fi
    if [ $ALLREPOS -eq 0 ] && grep -qx "$name" "$OVERLAY/repos.optional" 2>/dev/null; then SKIPPED+=("optional big upstream clone (use --all-repos): $name"); continue; fi
    act "git clone $origin ${dest#$H/}"
    if [ $DRY -eq 0 ]; then
      mkdir -p "$(dirname "$dest")"
      if git clone --quiet "$origin" "$dest"; then
        cur="$(git -C "$dest" branch --show-current)"
        if [ -n "$branch" ] && [ "$branch" != "(detached)" ] && [ "$cur" != "$branch" ] && git -C "$dest" rev-parse --verify -q "origin/$branch" >/dev/null; then git -C "$dest" checkout --quiet "$branch"; fi
      else warn "clone failed: $name (is 'gh auth login' / ssh key set up?)"; ERR=1; fi
    fi
  done < "$OREPOS"
  NWT="$(awk -F'\t' '$2=="worktree"' "$OREPOS" | wc -l | tr -d ' ')"
  [ "$NWT" -gt 0 ] && SKIPPED+=("$NWT git worktrees not cloned (branch + main repo listed in the overlay repos.tsv; recreate with 'git worktree add' only if needed)")
fi

say; say "== 4. ~/.claude files (public templates and generic files merged with the overlay)"
while IFS= read -r -d '' f; do
  rel="${f#$EFF/claude/}"
  case "$rel" in plugins.json|placeholders.txt|hook-deps.tsv|*.links.tsv) continue;; esac
  install_file "$f" "$C/$rel"
done < <(find "$EFF/claude" -type f -not -name .DS_Store -not -name "*.pyc" -not -path "*/__pycache__/*" -print0 | LC_ALL=C sort -z)
while IFS=$'\t' read -r name tgt; do
  [ -n "$name" ] || continue; tgt="${tgt//__HOME__/$H}"; link_to "$tgt" "$C/skills/$name"
done < "$EFF/claude/skills.links.tsv"
while IFS=$'\t' read -r name tgt; do
  [ -n "$name" ] || continue; tgt="${tgt//__HOME__/$H}"; link_to "$tgt" "$C/commands/$name"
done < "$EFF/claude/commands.links.tsv"
# hook scripts that live in cloned repos
while IFS=$'\t' read -r p kind; do
  case "$kind" in repo:*)
    r="${p//__HOME__/$H}"; rn="${kind#repo:}"
    if [ -e "$r" ]; then continue; fi
    if [ -n "$OREPOS" ] && awk -F'\t' -v r="$rn" '$2=="repo" && $1 ~ ("/" r "$") {f=1} END{exit !f}' "$OREPOS"; then say "  hook script ${r#$H/} will come from repo $rn (cloned in step 3)"
    else warn "hook script missing: ${r#$H/} (repo $rn is not cloneable)"; ERR=1; fi;;
  esac
done < "$EFF/claude/hook-deps.tsv"

say; say "== 5. ~/.agents skills"
if [ -d "$EFF/agents" ]; then
  act "rsync agents/skills/ -> .agents/skills/  ($(ls "$EFF/agents/skills" | wc -l | tr -d ' ') unlocked skills; existing differing files backed up)"
  if [ $DRY -eq 0 ]; then mkdir -p "$BK/.agents"; rsync -a --backup --backup-dir="$BK/.agents/skills" "$EFF/agents/skills/" "$H/.agents/skills/"; fi
  [ -f "$EFF/agents/skill-lock.json" ] && install_file "$EFF/agents/skill-lock.json" "$H/.agents/.skill-lock.json"
  [ -f "$EFF/agents/skills-lock.json" ] && install_file "$EFF/agents/skills-lock.json" "$H/skills-lock.json"
  if [ -f "$EFF/agents/skill-lock.json" ]; then
    python3 - "$EFF/agents/skill-lock.json" > "$TMP/locked.tsv" <<'PY'
import json, sys, collections
by = collections.defaultdict(list)
for n, v in json.load(open(sys.argv[1]))["skills"].items(): by[v["source"]].append(n)
for s in sorted(by): print(s + "\t" + " ".join(sorted(by[s])))
PY
    while IFS=$'\t' read -r src names; do
      cmd="npx --yes skills add $src -g -y --skill ${names// / --skill }"
      act "(best-effort) $cmd"
      if [ $DRY -eq 0 ]; then
        if command -v npx >/dev/null 2>&1; then
          ( cd "$TMP" && eval "$cmd" ) >/dev/null 2>&1 || { warn "skills CLI install failed for $src; run manually: $cmd"; TODO+=("re-run: $cmd"); }
        else TODO+=("run: $cmd"); fi
      fi
    done < "$TMP/locked.tsv"
  fi
else say "  skipped (no overlay agents data)"; fi

say; say "== 6. Claude plugins"
if [ $PLUGINS -eq 0 ]; then say "  skipped (--no-plugins)"
elif [ ! -f "$EFF/claude/plugins.json" ]; then say "  skipped (no plugins.json)"
else
  python3 - "$EFF/claude/plugins.json" > "$TMP/plugins.cmds" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for m in d.get("marketplaces", []):
    print("M\t%s\t%s" % (m["name"], m["add_arg"]))
for p in d.get("plugins", []):
    if p["id"].endswith("@builtin") or not p["installed"]: continue
    print("P\t%s\t%s" % (p["id"], "enabled" if p["enabled"] else "disabled"))
PY
  HAVE_CLAUDE=0; command -v claude >/dev/null 2>&1 && HAVE_CLAUDE=1
  MKLIST=""; PLLIST=""
  if [ $HAVE_CLAUDE -eq 1 ]; then
    MKLIST="$(claude plugin marketplace list 2>/dev/null || true)"
    PLLIST="$(claude plugin list 2>/dev/null | sed -n 's/^[^A-Za-z0-9]*\([A-Za-z0-9_.-]*@[A-Za-z0-9_.-]*\)[[:space:]]*$/\1/p' || true)"
  fi
  while IFS=$'\t' read -r t a b; do
    if [ "$t" = M ]; then
      if printf '%s' "$MKLIST" | grep -qw -- "$a"; then say "  marketplace present: $a"; continue; fi
      act "claude plugin marketplace add $b   ($a)"
      [ $DRY -eq 0 ] && [ $HAVE_CLAUDE -eq 1 ] && { claude plugin marketplace add "$b" >/dev/null 2>&1 || { warn "marketplace add failed: $b"; ERR=1; }; }
    else
      if printf '%s\n' "$PLLIST" | grep -qxF -- "$a"; then say "  plugin already installed: $a"; continue; fi
      act "claude plugin install $a   (state: $b)"
      if [ $DRY -eq 0 ] && [ $HAVE_CLAUDE -eq 1 ]; then
        claude plugin install "$a" >/dev/null 2>&1 || { warn "plugin install failed: $a"; ERR=1; }
        [ "$b" = disabled ] && claude plugin disable "$a" >/dev/null 2>&1
      fi
    fi
  done < "$TMP/plugins.cmds"
  [ $DRY -eq 0 ] && [ $HAVE_CLAUDE -eq 0 ] && TODO+=("install claude, then re-run bootstrap for plugins")
fi

say; say "== 7. launchd jobs (public templates + overlay plists; opt in with --launchd)"
if [ $LAUNCHD -eq 1 ]; then
  UIDN="$(id -u)"
  # deps rows: public + overlay, labels rendered, overlay wins on equal label
  : > "$TMP/deps.raw"
  for df in "$REPO/launchd/deps.tsv" "$OVERLAY/launchd/deps.tsv"; do
    [ -f "$df" ] || continue
    grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$df" | while IFS= read -r l; do render_str "$l"; printf '\n'; done >> "$TMP/deps.raw"
  done
  awk -F'\t' '{r[$1]=$0} END{for(k in r) print r[k]}' "$TMP/deps.raw" | LC_ALL=C sort > "$TMP/deps.tsv"
  # overlay symlinks (link = name relative to ~/Library/LaunchAgents, or a full path)
  if [ -n "$OVERLAY" ] && [ -f "$OVERLAY/launchd/links.tsv" ]; then
    while IFS=$'\t' read -r lk tg; do
      [ -n "$lk" ] || continue; case "$lk" in '#'*) continue;; esac
      lk="$(render_str "$lk")"; tg="$(render_str "$tg")"; case "$lk" in /*) ;; *) lk="$H/Library/LaunchAgents/$lk";; esac
      link_to "$tg" "$lk"
    done < "$OVERLAY/launchd/links.tsv"
  fi
  # job list: label<TAB>source<TAB>what; overlay plist beats a template with the same label
  : > "$TMP/jobs.raw"
  for src in "$REPO"/launchd/*.plist.tmpl "${OVERLAY:-/nonexistent-overlay}"/launchd/*.plist; do
    [ -f "$src" ] || continue
    lab="$(python3 -c 'import plistlib,sys;print(plistlib.load(open(sys.argv[1],"rb"))["Label"])' "$src" 2>/dev/null)"
    pre="launchd"; case "$src" in "$REPO"/*) ;; *) pre="overlay launchd";; esac
    printf '%s\t%s\t%s/%s\n' "$lab" "$src" "$pre" "$(basename "$src")" >> "$TMP/jobs.raw"
  done
  awk -F'\t' '{r[$1" "NR]=$0; last[$1]=NR; row[$1]=$0} END{for(k in row) print row[k]}' "$TMP/jobs.raw" | LC_ALL=C sort > "$TMP/jobs.tsv"
  while IFS=$'\t' read -r rawlabel src what; do
    if [ -z "$rawlabel" ]; then warn "cannot read Label from $what"; ERR=1; continue; fi
    label="$(render_str "$rawlabel")"
    drow="$(awk -F'\t' -v l="$label" '$1==l{print; exit}' "$TMP/deps.tsv")"
    dpath="$(printf '%s' "$drow" | cut -f2)"; drepo="$(printf '%s' "$drow" | cut -f3)"; dneeds="$(printf '%s' "$drow" | cut -f4)"
    if [ "$dneeds" = overlay ] && [ -z "$OVERLAY" ]; then
      say "  SKIP     $label  (needs a private overlay; none configured)"; SKIPPED+=("launchd skipped: $label"); continue
    fi
    dest="$H/Library/LaunchAgents/$label.plist"
    render_checked "$src" "$TMP/job.plist" "$what"; rc=$?
    if [ $rc -eq 1 ]; then say "  SKIP     $label  (needs a private overlay; none configured)"; SKIPPED+=("launchd skipped: $label"); continue; fi
    [ $rc -eq 2 ] && continue
    if ! plutil -lint "$TMP/job.plist" >/dev/null 2>&1; then warn "plutil -lint failed: $label"; ERR=1; continue; fi
    if [ -n "$dpath" ] && [ "$dpath" != "-" ]; then
      dpath="$(render_str "$dpath")"
      if [ ! -e "$dpath" ]; then
        ok=0
        if [ $DRY -eq 1 ] && [ -n "$OREPOS" ] && [ -n "$drepo" ] && [ "$drepo" != "-" ] && awk -F'\t' -v r="$drepo" '$2=="repo" && $1 ~ ("/" r "$") {f=1} END{exit !f}' "$OREPOS"; then ok=1; fi
        if [ $ok -eq 0 ]; then
          tp="$dpath"; case "$dpath" in "$H"/*) tp="~${dpath#$H}";; esac
          say "  SKIP     $label  (needs $tp...; not present)"; SKIPPED+=("launchd skipped: $label"); continue
        fi
      fi
    fi
    python3 - "$TMP/job.plist" > "$TMP/logdirs" <<'PY'
import plistlib, sys, os
d = plistlib.load(open(sys.argv[1], "rb"))
for k in ("StandardOutPath", "StandardErrorPath"):
    if k in d: print(os.path.dirname(d[k]))
PY
    if [ $DRY -eq 0 ]; then while read -r ld; do mkdir -p "$ld" 2>/dev/null; done < "$TMP/logdirs"; fi
    loaded=0; launchctl print "gui/$UIDN/$label" >/dev/null 2>&1 && loaded=1
    same=0; [ -f "$dest" ] && cmp -s "$TMP/job.plist" "$dest" && same=1
    if [ $loaded -eq 1 ] && [ $same -eq 1 ]; then say "  $label: loaded, unchanged"; continue; fi
    if [ $loaded -eq 1 ]; then act "$label: loaded, plist differs -> backup, bootout, copy, lint, bootstrap"
    elif [ $same -eq 1 ]; then act "$label: not loaded, plist installed -> bootstrap"
    elif [ -f "$dest" ]; then act "$label: not loaded, plist differs -> backup, copy, bootstrap"
    else act "$label: not loaded, not installed -> install, bootstrap"; fi
    if [ $DRY -eq 0 ]; then
      if [ $same -eq 0 ]; then backup "$dest"; mkdir -p "$(dirname "$dest")"; cp "$TMP/job.plist" "$dest"; fi
      [ $loaded -eq 1 ] && launchctl bootout "gui/$UIDN/$label" >/dev/null 2>&1
      launchctl bootstrap "gui/$UIDN" "$dest" || { warn "launchctl bootstrap failed: $label"; ERR=1; }
    fi
  done < "$TMP/jobs.tsv"
else say "  skipped (pass --launchd to install launchd jobs)"; fi

say; say "== summary"
if [ -s "$EFF/claude/placeholders.txt" ]; then say "  Secret placeholders to fill in ~/.claude/settings.json:"; sed 's/^/    __SECRET:/;s/$/__/' "$EFF/claude/placeholders.txt"
else say "  Secret placeholders: none (settings.json has no secret values)"; fi
say "  Manual steps still needed:"
say "    - claude login (credentials are never stored in this repo)"
if [ -n "$OVERLAY" ] && [ -f "$OVERLAY/manual-steps.txt" ]; then
  while IFS= read -r l || [ -n "$l" ]; do l="${l%$'\r'}"; [ -n "$l" ] && say "    - $l"; done < "$OVERLAY/manual-steps.txt"
fi
for t in "${TODO[@]:-}"; do [ -n "$t" ] && say "    - $t"; done
if [ ${#SKIPPED[@]} -gt 0 ]; then say "  Skipped / not recoverable:"; for s in "${SKIPPED[@]}"; do say "    - $s"; done; fi
[ -d "$BK" ] && say "  Backups of overwritten files: $BK"
[ $DRY -eq 1 ] && say "  DRY RUN complete: nothing was changed."
exit $ERR
