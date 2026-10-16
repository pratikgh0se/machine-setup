#!/usr/bin/env python3
"""Build claude/plugins.json from installed_plugins.json, known_marketplaces.json and settings.json. Deterministic."""
import json, sys
pdir, settings, out = sys.argv[1:4]
inst = json.load(open(pdir + "/installed_plugins.json")).get("plugins", {})
known = json.load(open(pdir + "/known_marketplaces.json"))
st = json.load(open(settings))
enabled = st.get("enabledPlugins", {})
extra = st.get("extraKnownMarketplaces", {})
mk = {}
for name, v in list(extra.items()) + list(known.items()):
    s = v.get("source", {})
    mk[name] = {"name": name, "source": s}
mks = []
for name in sorted(mk):
    s = mk[name]["source"]
    arg = s.get("repo") or s.get("url") or s.get("path") or ""
    mks.append({"name": name, "source": s, "add_arg": arg})
plugins = []
for pid in sorted(set(inst) | set(enabled)):
    plugins.append({"id": pid, "enabled": bool(enabled.get(pid, False)), "installed": pid in inst,
                    "version": (inst.get(pid) or [{}])[0].get("version")})
json.dump({"marketplaces": mks, "plugins": plugins}, open(out, "w"), indent=2); open(out, "a").write("\n")
