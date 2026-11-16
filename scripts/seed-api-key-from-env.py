#!/usr/bin/env python3
import json
import os

envp = os.path.join(os.path.dirname(__file__), "..", ".env")
settings = os.path.expanduser("~/Library/Application Support/cicada-tauri/settings.json")
key = ""
base = "https://openrouter.ai/api/v1"
with open(envp) as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip("\"'")
        if k == "OPENROUTER_API_KEY":
            key = v
        elif k == "OPENROUTER_BASE_URL":
            base = v
os.makedirs(os.path.dirname(settings), exist_ok=True)
d = {}
if os.path.exists(settings):
    with open(settings) as f:
        d = json.load(f)
changed = False
if key and not (d.get("openrouterApiKey") or "").strip():
    d["openrouterApiKey"] = key
    changed = True
if base and not (d.get("openrouterBaseUrl") or "").strip():
    d["openrouterBaseUrl"] = base
    changed = True
if changed:
    with open(settings, "w") as f:
        json.dump(d, f, indent=2)
    print("seeded settings from .env")
else:
    print("ok key_len", len(d.get("openrouterApiKey") or ""))
