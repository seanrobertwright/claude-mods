#!/bin/sh
# Fails when a tracked file, as staged, holds personal data or U+FFFD.
# The patterns are assembled at run time so this file never matches itself.
set -u

user="sean""r"
mail="${user}obertwright""@gmail.com"
fffd="$(printf '\357\277\275')"

status=0
for pattern in "$fffd" "$user" "C:\Users\$user" "/c/Users/$user" "$mail"; do
  if git grep --cached -n -I -F -i -e "$pattern" -- . >/dev/null 2>&1; then
    echo "check-personal-data: a tracked file contains a forbidden string:" >&2
    git grep --cached -n -I -F -i -e "$pattern" -- . >&2
    status=1
  fi
done
exit "$status"
