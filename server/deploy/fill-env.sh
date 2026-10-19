#!/usr/bin/env bash
# Fill the four personal values in /opt/birdbrain/.env from interactive prompts.
# Secrets are read with echo off and confirmed twice; nothing typed is ever printed.
set -euo pipefail
F=/opt/birdbrain/.env
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 77; }
[ -f "$F" ] || { echo "missing $F" >&2; exit 1; }

set_var() {  # name value  (replace the line, or append if absent)
  local v="$1" val="$2" esc
  esc="$(printf '%s' "$val" | sed -e 's/[\&|]/\&/g')"
  if grep -qE "^$v=" "$F"; then sed -i "s|^$v=.*|$v=$esc|" "$F"; else printf '%s=%s\n' "$v" "$val" >> "$F"; fi
}

ask() {  # name prompt [silent] [strip-spaces]
  local v="$1" p="$2" silent="${3:-}" strip="${4:-}" val val2
  while :; do
    if [ -n "$silent" ]; then read -r -s -p "$p: " val; echo; else read -r -p "$p: " val; fi
    val="${val//$'\r'/}"
    [ -n "$strip" ] && val="${val// /}"
    if [ -z "$val" ]; then echo "   empty, try again"; continue; fi
    case "$val" in *" "*) echo "   contains a space, try again"; continue;; esac
    case "$val" in \"*|\'*) echo "   do not use quotes, try again"; continue;; esac
    if [ -n "$silent" ]; then
      read -r -s -p "$p (type again to confirm): " val2; echo
      val2="${val2//$'\r'/}"; [ -n "$strip" ] && val2="${val2// /}"
      if [ "$val" != "$val2" ]; then echo "   the two entries differ, try again"; continue; fi
    fi
    break
  done
  set_var "$v" "$val"
  echo "   $v saved (${#val} characters)"
}

echo "Filling $F. Secrets are typed invisibly. To paste: right-click, or Ctrl+Shift+V."
echo
ask ADMIN_EMAIL        "ADMIN_EMAIL  (the email you will log in with; becomes admin)"
ask SMTP_USER          "SMTP_USER    (the dedicated Birdbrain Gmail address)"
ask SMTP_APP_PASSWORD  "SMTP_APP_PASSWORD  (Gmail app password; spaces are removed)" silent strip
ask GEMINI_API_KEY     "GEMINI_API_KEY" silent
chmod 600 "$F"; chown root:root "$F"
echo
echo "Done. Variables now (values hidden):"
sed -E 's/=.+/=<set>/; s/=$/=<EMPTY>/' "$F"
