#!/usr/bin/env bash
# export.sh: capture the LIVE machine. Personal values go ONLY to the private overlay; the public repo changes only for
# generic files that already exist in it (hooks, commands, skills, agents, output-styles, keybindings). Idempotent.
#   export.sh [--dry-run|-n]     --dry-run lists `would write [overlay|public] <rel>`, writes nothing
# Needs an overlay (MACHINE_SETUP_PRIVATE or ../machine-setup-private); without one it exits 3 and writes nothing.
# Secrets become "__SECRET:<NAME>__" placeholders; secret-scan.sh (both repos) and leak-scan.sh must pass or this exits non-zero.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"   # setup/
REPO="$(cd "$ROOT/.." && pwd)"           # public repo
DRY=0
for a in "$@"; do case "$a" in
  --dry-run|-n) DRY=1;; *) echo "unknown flag: $a" >&2; exit 2;; esac; done
# shellcheck source=lib/overlay.sh
. "$ROOT/lib/overlay.sh"
ms_resolve_overlay
if [ -z "$OVERLAY" ]; then
  echo "export: no overlay configured; refusing to write personal files (set MACHINE_SETUP_PRIVATE or create ../machine-setup-private)" >&2
  exit 3
fi
ms_load_config

H="${HOME}"; C="$H/.claude"; A="$H/.agents"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
NEW="$TMP/new"        # overlay content to write (units: claude/ agents/ launchd/ repos.tsv)
PUBNEW="$TMP/pubnew"  # public files to refresh (repo-relative paths)
STAGE="$TMP/stage"    # tokenised live copy of ~/.claude items, split later into public refresh / overlay
mkdir -p "$NEW/claude" "$PUBNEW" "$STAGE/claude"
RS=(rsync -a --exclude=__pycache__ --exclude='*.pyc' --exclude=.DS_Store)
say() { printf '  %s\n' "$*"; }

rewrite_home() {  # rewrite $HOME -> __HOME__ in text files under $1
  grep -rIl --null -F "$H" "$1" 2>/dev/null | xargs -0 -I{} sed -i '' "s|$H|__HOME__|g" "{}" || true
}
links_tsv() {     # symlink map of dir $1 -> file $2 (name<TAB>target, HOME as token)
  find "$1" -mindepth 1 -maxdepth 1 -type l | LC_ALL=C sort | while read -r l; do
    printf '%s\t%s\n' "$(basename "$l")" "$(readlink "$l" | sed "s|^$H|__HOME__|")"
  done > "$2"
}

echo "== overlay"
say "overlay: $OVERLAY"

echo "== claude"
if [ -f "$C/settings.json" ]; then
  python3 "$ROOT/lib/scrub_settings.py" "$C/settings.json" "$TMP/live.json" "$H" "$NEW/claude/placeholders.txt"
  python3 "$ROOT/lib/diff_settings.py" "$REPO/claude/settings.template.json" "$TMP/live.json" "$NEW/claude/settings.json"
  say "settings.json (scrubbed, diff vs template; $(wc -l < "$NEW/claude/placeholders.txt" | tr -d ' ') placeholders)"
fi
if [ -f "$C/CLAUDE.md" ]; then mkdir -p "$STAGE/claude"; cp "$C/CLAUDE.md" "$STAGE/claude/CLAUDE.md"; rewrite_home "$STAGE/claude/CLAUDE.md"; say CLAUDE.md; fi
if [ -f "$C/keybindings.json" ]; then cp "$C/keybindings.json" "$STAGE/claude/keybindings.json"; say keybindings.json; fi
for d in hooks agents output-styles; do
  if [ -d "$C/$d" ]; then
    mkdir -p "$STAGE/claude/$d"; "${RS[@]}" "$C/$d/" "$STAGE/claude/$d/"; rewrite_home "$STAGE/claude/$d"
    say "$d/ ($(find "$STAGE/claude/$d" -type f | wc -l | tr -d ' ') files)"
  fi
done
# commands: real files copied, symlinks recorded
if [ -d "$C/commands" ]; then
  mkdir -p "$STAGE/claude/commands"
  find "$C/commands" -maxdepth 1 -type l -exec basename {} \; > "$TMP/cmdlinks"
  "${RS[@]}" --no-links --exclude-from="$TMP/cmdlinks" "$C/commands/" "$STAGE/claude/commands/"
  rewrite_home "$STAGE/claude/commands"
  links_tsv "$C/commands" "$NEW/claude/commands.links.tsv"
  say "commands: $(wc -l < "$NEW/claude/commands.links.tsv" | tr -d ' ') symlinks, $(find "$STAGE/claude/commands" -type f | wc -l | tr -d ' ') real files"
fi
# skills: real dirs copied (except account-synced 'synced'), symlinks recorded
if [ -d "$C/skills" ]; then
  mkdir -p "$STAGE/claude/skills"
  { find "$C/skills" -maxdepth 1 -type l -exec basename {} \;; echo synced; } > "$TMP/sklinks"
  "${RS[@]}" --no-links --exclude-from="$TMP/sklinks" "$C/skills/" "$STAGE/claude/skills/"
  rewrite_home "$STAGE/claude/skills"
  links_tsv "$C/skills" "$NEW/claude/skills.links.tsv"
  say "skills: $(wc -l < "$NEW/claude/skills.links.tsv" | tr -d ' ') symlinks; real dirs: $(ls "$STAGE/claude/skills" | tr '\n' ' ')"
fi
# hook/statusline-referenced paths
if [ -f "$TMP/live.json" ]; then
  python3 "$ROOT/lib/hookpaths.py" "$TMP/live.json" "$H" > "$NEW/claude/hook-deps.tsv"
  while IFS=$'\t' read -r p kind; do
    [ "$kind" = claude ] || continue
    r="${p/__HOME__/$H}"; rel="${r#$C/}"
    case "$rel" in hooks/*) continue;; esac
    if [ -f "$r" ]; then mkdir -p "$STAGE/claude/$(dirname "$rel")"; cp "$r" "$STAGE/claude/$rel"; rewrite_home "$STAGE/claude/$rel"; say "extra script $rel"; fi
  done < "$NEW/claude/hook-deps.tsv"
fi
python3 "$ROOT/lib/plugins.py" "$C/plugins" "$C/settings.json" "$NEW/claude/plugins.json"
rewrite_home "$NEW/claude/plugins.json"
say "plugins.json"

# split the staged items: file already in the public tree -> public refresh; otherwise -> overlay
while IFS= read -r -d '' f; do
  rel="${f#$STAGE/claude/}"
  if [ -f "$REPO/claude/$rel" ]; then
    cmp -s "$f" "$REPO/claude/$rel" || { mkdir -p "$PUBNEW/claude/$(dirname "$rel")"; cp "$f" "$PUBNEW/claude/$rel"; }
  else
    mkdir -p "$NEW/claude/$(dirname "$rel")"; cp -p "$f" "$NEW/claude/$rel"
  fi
done < <(find "$STAGE/claude" -type f -print0 | LC_ALL=C sort -z)
for pf in $(cd "$REPO" && { find claude/hooks claude/commands claude/skills claude/agents claude/output-styles -type f 2>/dev/null; [ -f claude/keybindings.json ] && echo claude/keybindings.json; } | LC_ALL=C sort); do
  [ -f "$STAGE/${pf}" ] || say "public: $pf not on this machine, left unchanged"
done

echo "== agents (~/.agents)"
if [ -d "$A" ] || [ -f "$H/skills-lock.json" ]; then
  mkdir -p "$NEW/agents"
  [ -f "$A/.skill-lock.json" ] && cp "$A/.skill-lock.json" "$NEW/agents/skill-lock.json"
  [ -f "$H/skills-lock.json" ] && cp "$H/skills-lock.json" "$NEW/agents/skills-lock.json"
  if [ -d "$A/skills" ]; then
    if [ -f "$A/.skill-lock.json" ]; then
      python3 -c 'import json,sys;print("\n".join(sorted(json.load(open(sys.argv[1]))["skills"])))' "$A/.skill-lock.json" > "$TMP/locked"
    else : > "$TMP/locked"; fi
    mkdir -p "$NEW/agents/skills"
    # copy only skills NOT in the lock (lock-installed ones are re-fetched); drop bulky canvas-fonts
    "${RS[@]}" --exclude=canvas-fonts --exclude-from="$TMP/locked" "$A/skills/" "$NEW/agents/skills/"
    ls "$A/skills" | LC_ALL=C sort > "$NEW/agents/skills.all.txt"
    say "agents/skills: $(ls "$NEW/agents/skills" | wc -l | tr -d ' ') copied of $(wc -l < "$NEW/agents/skills.all.txt" | tr -d ' '); $(wc -l < "$TMP/locked" | tr -d ' ') via lock"
  fi
else say "no ~/.agents data"; fi

echo "== launchd"
mkdir -p "$NEW/launchd"
: > "$TMP/pub_labels"
for t in "$REPO"/launchd/*.plist.tmpl; do
  [ -f "$t" ] || continue
  python3 -c 'import plistlib,sys;print(plistlib.load(open(sys.argv[1],"rb"))["Label"].replace("__LABEL_PREFIX__",sys.argv[2]))' "$t" "$LP" >> "$TMP/pub_labels" 2>/dev/null || true
done
: > "$TMP/deps.rows"; : > "$TMP/links.rows"
for f in "$H"/Library/LaunchAgents/"$LP".*.plist; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  b="$(basename "$f")"
  if [ -L "$f" ]; then printf '%s\t%s\n' "$b" "$(readlink "$f" | sed "s|^$H|__HOME__|")" >> "$TMP/links.rows"; continue; fi
  lab="${b%.plist}"
  if grep -qxF -- "$lab" "$TMP/pub_labels"; then continue; fi
  python3 - "$f" "$NEW/launchd/$b" "$H" "$LP" >> "$TMP/deps.rows" <<'PY'
import re, sys, plistlib
src, dst, home, lp = sys.argv[1:5]
s = open(src, encoding="utf-8").read().replace(home, "__HOME__").replace(lp, "__LABEL_PREFIX__")
open(dst, "w", encoding="utf-8").write(s)
d = plistlib.loads(s.encode("utf-8"))
strs = [x for x in d.get("ProgramArguments", []) if isinstance(x, str)] + [d.get("WorkingDirectory", "")]
req = repo = "-"
for x in strs:
    m = re.search(r"__HOME__/CodeBase/([^/\s\"']+)", x)
    if m: req, repo = "__HOME__/CodeBase/" + m.group(1), m.group(1); break
print("%s\t%s\t%s\t-" % (d["Label"], req, repo))
PY
done
{ printf '# label\trequired_path\trepo\tneeds\n'; LC_ALL=C sort "$TMP/deps.rows"; } > "$NEW/launchd/deps.tsv"
LC_ALL=C sort "$TMP/links.rows" > "$NEW/launchd/links.tsv"
say "$(find "$NEW/launchd" -name '*.plist' | wc -l | tr -d ' ') personal plists (prefix $LP)"

echo "== repos"
: > "$TMP/repos.rows"
for d in "$H"/CodeBase/*/; do
  [ -d "$d" ] || continue; d="${d%/}"; name="$(basename "$d")"
  case "$name" in machine-setup|machine-setup-private) continue;; esac
  [ -e "$d/.git" ] || continue
  origin="$(git -C "$d" remote get-url origin 2>/dev/null || true)"; origin="${origin//$H/__HOME__}"
  branch="$(git -C "$d" branch --show-current 2>/dev/null || true)"; [ -n "$branch" ] || branch="(detached)"
  main="-"
  if [ -f "$d/.git" ]; then
    kind=worktree
    cd_="$(git -C "$d" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
    [ -n "$cd_" ] && main="$(printf '%s' "${cd_%/.git}" | sed "s|^$H|__HOME__|")"
  elif [ -n "$origin" ]; then kind=repo
  else kind=local-only; fi
  [ -n "$origin" ] || origin="-"
  printf '%s\t%s\t%s\t%s\t%s\n' "__HOME__/CodeBase/$name" "$kind" "$origin" "$branch" "$main" >> "$TMP/repos.rows"
done
LC_ALL=C sort "$TMP/repos.rows" > "$NEW/repos.tsv"
say "$(wc -l < "$NEW/repos.tsv" | tr -d ' ') repos"

# ---- apply (or just report) -------------------------------------------------------------------------------------
apply_overlay() {  # apply_overlay TARGET
  mkdir -p "$1"
  for unit in claude agents launchd; do
    if [ -d "$NEW/$unit" ]; then mkdir -p "$1/$unit"; rsync -a --checksum --delete "$NEW/$unit/" "$1/$unit/"; else rm -rf "${1:?}/$unit"; fi
  done
  if [ -f "$NEW/repos.tsv" ]; then if [ ! -f "$1/repos.tsv" ] || ! cmp -s "$NEW/repos.tsv" "$1/repos.tsv"; then cp "$NEW/repos.tsv" "$1/repos.tsv"; fi; fi
}
apply_public() {  # apply_public TARGET
  ( cd "$PUBNEW" && find . -type f | sed 's|^\./||' ) | while read -r f; do cat "$PUBNEW/$f" > "$1/$f"; done
}

SCAN_PUB=""; SCAN_OV="$OVERLAY"; LEAK_ROOT=()
if [ $DRY -eq 1 ]; then
  # overlay: compare each unit against the overlay checkout
  ( cd "$NEW" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | while read -r f; do
      [ -f "$OVERLAY/$f" ] && cmp -s "$f" "$OVERLAY/$f" || printf '  would write [overlay] %s\n' "$f"; done )
  ( cd "$PUBNEW" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | while read -r f; do
      [ -f "$REPO/$f" ] && cmp -s "$f" "$REPO/$f" || printf '  would write [public] %s\n' "$f"; done )
  EXC=(--exclude=.git --exclude=node_modules --exclude=__pycache__ --exclude=.dev --exclude=.DS_Store)
  mkdir -p "$TMP/pubcopy" "$TMP/ovcopy"
  rsync -a "${EXC[@]}" "$REPO/" "$TMP/pubcopy/"
  rsync -a "${EXC[@]}" "$OVERLAY/" "$TMP/ovcopy/"
  apply_overlay "$TMP/ovcopy"; apply_public "$TMP/pubcopy"
  SCAN_PUB="$TMP/pubcopy"; SCAN_OV="$TMP/ovcopy"; LEAK_ROOT=(--root "$TMP/pubcopy")
else
  apply_overlay "$OVERLAY"; apply_public "$REPO"
  n_ov="$(cd "$NEW" && find . -type f | wc -l | tr -d ' ')"; n_pub="$(cd "$PUBNEW" && find . -type f | wc -l | tr -d ' ')"
  say "written: $n_ov overlay file(s) checked, $n_pub public file(s) refreshed"
fi

echo "== secret scan"
if [ -n "$SCAN_PUB" ]; then "$ROOT/secret-scan.sh" "$SCAN_PUB"; else "$ROOT/secret-scan.sh"; fi
SECRET_SCAN_OVERLAY=1 "$ROOT/secret-scan.sh" "$SCAN_OV"
echo "== leak scan"
MACHINE_SETUP_PRIVATE="$OVERLAY" "$ROOT/leak-scan.sh" ${LEAK_ROOT[@]+"${LEAK_ROOT[@]}"}
