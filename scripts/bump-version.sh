#!/bin/sh
# Bumps the app version in web/setup.js and the offline-cache name in web/sw.js (so browsers fetch the new files).
# Usage: scripts/bump-version.sh [minor|major|patch]     default: minor (1.4.0 -> 1.5.0)
set -e
cd "$(git rev-parse --show-toplevel)"
part=${1:-minor}
cur=$(sed -n "s/^export const APP_VERSION = '\([0-9.]*\)';/\1/p" web/setup.js)
[ -n "$cur" ] || { echo "APP_VERSION not found in web/setup.js" >&2; exit 1; }
MA=${cur%%.*}; rest=${cur#*.}; MI=${rest%%.*}; PA=${rest#*.}
case $part in
  major) MA=$((MA + 1)); MI=0; PA=0 ;;
  minor) MI=$((MI + 1)); PA=0 ;;
  patch) PA=$((PA + 1)) ;;
  *) echo "usage: $0 [minor|major|patch]" >&2; exit 2 ;;
esac
new="$MA.$MI.$PA"
perl -pi -e "s/^export const APP_VERSION = '[0-9.]+';/export const APP_VERSION = '$new';/" web/setup.js
perl -pi -e "s/^const CACHE = '[^']*';/const CACHE = 'gvm-show-$new';/" web/sw.js
# CHANGELOG.md: if the Unreleased section has notes, they become this version's notes (dated today)
# and a new empty Unreleased section starts.
if [ -f CHANGELOG.md ]; then
  NEW="$new" DAY="$(date +%Y-%m-%d)" perl -0pi -e '
    if (/^## \[Unreleased\][ \t]*\n(.*?)(?=^## \[|^\[Unreleased\]:|\z)/ms && $1 =~ /\S/) {
      s/^## \[Unreleased\][ \t]*\n/## [Unreleased]\n\n## [$ENV{NEW}] - $ENV{DAY}\n/m;
    }' CHANGELOG.md
fi
echo "$new"
