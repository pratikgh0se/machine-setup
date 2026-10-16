# overlay.sh: sourced by bootstrap.sh, export.sh, autosync.sh. Single overlay selector (spec 11.2).
# Requires $REPO (public checkout root). Sets OVERLAY (absolute, symlinks resolved; empty = none) and LP (label prefix).

ms_resolve_overlay() {
  OVERLAY=""
  local v="${MACHINE_SETUP_PRIVATE:-}"
  if [ -n "$v" ]; then
    [ "$v" = none ] && return 0
    if [ ! -d "$v" ]; then echo "overlay: MACHINE_SETUP_PRIVATE=$v is not a directory" >&2; exit 2; fi
    OVERLAY="$(cd "$v" && pwd -P)"; return 0
  fi
  local sib; sib="$(cd "$REPO/.." && pwd -P)/machine-setup-private"
  if [ -d "$sib" ]; then OVERLAY="$(cd "$sib" && pwd -P)"; fi
  return 0
}

# Parse (never source) $OVERLAY/config.env. Only LABEL_PREFIX is used; unknown keys are ignored.
ms_load_config() {
  LP="com.machine-setup"
  [ -n "$OVERLAY" ] && [ -f "$OVERLAY/config.env" ] || return 0
  local line key val set=0 lp=""
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"; line="${line%"${line##*[![:space:]]}"}"
    case "$line" in ''|'#'*) continue;; 'export '*) line="${line#export }";; esac
    key="${line%%=*}"; [ "$key" = "$line" ] && continue
    val="${line#*=}"
    case "$val" in
      \"*\") [ ${#val} -ge 2 ] && val="${val:1:${#val}-2}";;
      \'*\') [ ${#val} -ge 2 ] && val="${val:1:${#val}-2}";;
    esac
    if [ "$key" = LABEL_PREFIX ]; then lp="$val"; set=1; fi
  done < "$OVERLAY/config.env"
  if [ $set -eq 1 ]; then
    if [[ "$lp" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then LP="$lp"; else echo "config: invalid LABEL_PREFIX" >&2; exit 2; fi
  fi
  return 0
}
