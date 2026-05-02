#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
SKIP_GIT=0
BUMP=""

usage() {
  cat <<'EOF'
Usage: pnpm run do-release [-- patch|minor|major|x.y.z] [--dry-run] [--no-git]

Releases pi-tmux-cursor-focus:
  - checks pnpm registry auth and package availability
  - bumps package.json version
  - validates Pi can load the extension
  - checks package tarball contents
  - optionally commits/tags/pushes when inside a git repo
  - publishes with pnpm

Examples:
  pnpm run do-release
  pnpm run do-release -- patch
  pnpm run do-release -- --dry-run
  pnpm run do-release -- minor --dry-run
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --no-git)
      SKIP_GIT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    patch|minor|major)
      BUMP="$1"
      shift
      ;;
    [0-9]*.[0-9]*.[0-9]*)
      BUMP="$1"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

pkg_get() {
  node -p "const pkg=require('./package.json'); pkg$1"
}

pkg_set_version() {
  VERSION="$1" node <<'EOF'
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.version = process.env.VERSION;
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
EOF
}

is_git_repo() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1
}

current_version="$(pkg_get '.version')"
package_name="$(pkg_get '.name')"

IFS='.' read -r major minor patch <<<"$current_version"

if [[ -z "$BUMP" ]]; then
  echo "Current version: $current_version"
  echo ""
  echo "Bump type:"
  echo "  1) patch  → $major.$minor.$((patch + 1))"
  echo "  2) minor  → $major.$((minor + 1)).0"
  echo "  3) major  → $((major + 1)).0.0"
  echo ""
  read -rp "Choose [1/2/3]: " choice

  case "$choice" in
    1) BUMP="patch" ;;
    2) BUMP="minor" ;;
    3) BUMP="major" ;;
    *)
      echo "Invalid choice" >&2
      exit 1
      ;;
  esac
fi

case "$BUMP" in
  patch) new_version="$major.$minor.$((patch + 1))" ;;
  minor) new_version="$major.$((minor + 1)).0" ;;
  major) new_version="$((major + 1)).0.0" ;;
  *) new_version="$BUMP" ;;
esac

if [[ "$new_version" == "$current_version" ]]; then
  echo "Version is already $new_version" >&2
  exit 1
fi

if is_git_repo && [[ "$SKIP_GIT" -eq 0 ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Git working tree is dirty. Commit/stash changes first, or pass --no-git." >&2
    git status --short >&2
    exit 1
  fi
fi

echo "Releasing $package_name $current_version → $new_version"

if ! pnpm whoami >/dev/null 2>&1; then
  echo "pnpm is not logged in. Run: pnpm login" >&2
  exit 1
fi

echo "pnpm user: $(pnpm whoami)"

if pnpm view "$package_name@$new_version" version >/dev/null 2>&1; then
  echo "$package_name@$new_version already exists in the registry" >&2
  exit 1
fi

pkg_set_version "$new_version"
restore_version() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    pkg_set_version "$current_version"
  fi
}
trap restore_version EXIT

echo ""
echo "Validating Pi extension load..."
pi -e "$ROOT" --list-models >/tmp/pi-tmux-cursor-focus-release-pi.out 2>&1

echo "Checking package contents..."
pnpm pack --dry-run

echo "Checking pnpm publish dry-run..."
pnpm publish --dry-run --no-git-checks

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo ""
  echo "Dry run complete. package.json restored to $current_version."
  exit 0
fi

if is_git_repo && [[ "$SKIP_GIT" -eq 0 ]]; then
  echo ""
  echo "Creating git commit and tag..."
  git add package.json
  git commit -m "v$new_version"
  git tag -m "v$new_version" "v$new_version"
  git push --follow-tags
fi

echo ""
echo "Publishing with pnpm..."
pnpm publish --no-git-checks

echo ""
echo "Done! Released $package_name@$new_version"
echo "Install with: pi install npm:$package_name"
