#!/bin/sh
# Fails when a tracked file, as staged, holds personal data or U+FFFD.
# The patterns are assembled at run time so this file never matches itself.
set -u

user="sean""r"
mail="${user}obertwright""@gmail.com"
fffd="$(printf '\357\277\275')"
# The one place the account name may show: this repository's own public address,
# which the README gives so the mods can be installed from it.
allowed="github.com/${user}obertwright""/claude-mods"

# Prints the matching lines that still hold the pattern once the allowed address is taken out.
# The strings reach awk through the environment, which leaves their backslashes alone.
offending() {
  git grep --cached -n -I -F -i -e "$1" -- . 2>/dev/null |
    PATTERN="$1" ALLOWED="$allowed" awk '
      BEGIN { pattern = tolower(ENVIRON["PATTERN"]); allowed = tolower(ENVIRON["ALLOWED"]) }
      {
        line = tolower($0)
        while ((at = index(line, allowed)) > 0) line = substr(line, 1, at - 1) substr(line, at + length(allowed))
        if (index(line, pattern) > 0) print
      }'
}

status=0
for pattern in "$fffd" "$user" "C:\Users\$user" "/c/Users/$user" "$mail"; do
  found="$(offending "$pattern")"
  if [ -n "$found" ]; then
    echo "check-personal-data: a tracked file contains a forbidden string:" >&2
    echo "$found" >&2
    status=1
  fi
done
exit "$status"
