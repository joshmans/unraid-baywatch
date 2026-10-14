#!/bin/bash
# Builds and (with --release) publishes a real installable release of the
# unraid-baywatch plugin: compiled frontend, esbuild-bundled +
# Node-SEA-packaged backend binary, packed into a Slackware .txz Unraid's own
# `<FILE Run="installpkg"><URL>...</URL><SHA256>...</SHA256></FILE>`
# convention expects (SHA256, not MD5 - the stronger hash Unraid's Community
# Apps review bot now retrofits onto plugins still declaring MD5), then
# (release mode only) tags, updates the .plg's version/SHA256 entities +
# CHANGES, and publishes a GitHub Release with the .txz attached. Modeled
# directly on unraid-docker-folders' own build.sh -
# see ROADMAP.md/the plan this came from for why that's the right template
# (it's a real, currently-published plugin using this exact pipeline shape).
#
# Must run on Linux x86_64 (matches Unraid's own host arch) - the SEA binary
# embeds a copy of whatever `node` builds it, so building on macOS would ship
# a binary that can't run on the target box. CI (.github/workflows/release.yml)
# runs this on ubuntu-latest; local runs are for testing the non-SEA steps
# only (bundle + a plain `node dist/bundle.cjs` smoke test), never for
# producing an artifact anyone ships.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NAME="unraid-baywatch"
RELEASE_MODE=false
[[ "${1:-}" == "--release" ]] && RELEASE_MODE=true

# Same-day re-run (a second release on one calendar day) gets a trailing
# letter (2026.09.19, then 2026.09.19b, 2026.09.19c, ...) rather than
# colliding with an existing tag - per explicit direction, not the earlier
# numeric -2/-3 suffix scheme. A function, not just inline code at the top,
# because two PRs merged close together fire two of these jobs at once
# (confirmed for real: merging #9 then #10 seconds apart raced exactly this
# way), and the version picked here has to be re-checked against whatever
# the *other* job already pushed, right before this one commits - not just
# once at the start, against whatever tags existed before either job's
# build even began.
pick_version() {
  local base candidate letters
  base="$(date +%Y.%m.%d)"
  if ! git rev-parse "v${base}" >/dev/null 2>&1; then
    echo "$base"
    return
  fi
  letters="bcdefghijklmnopqrstuvwxyz"
  for ((i = 0; i < ${#letters}; i++)); do
    candidate="${base}${letters:i:1}"
    if ! git rev-parse "v${candidate}" >/dev/null 2>&1; then
      echo "$candidate"
      return
    fi
  done
  echo "ran out of same-day letter suffixes (a-z) for ${base}" >&2
  return 1
}

VERSION="$(pick_version)"
echo "Building ${NAME} ${VERSION}"

echo "--- tsc (backend) ---"
npm run build

echo "--- vite (frontend) ---"
npm run build:frontend

echo "--- esbuild bundle ---"
npm run build:bundle

echo "--- Node SEA binary ---"
npm run build:sea

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

EMHTTP_DIR="$STAGE/usr/local/emhttp/plugins/${NAME}"
RCD_DIR="$STAGE/usr/local/etc/rc.d"
mkdir -p "$EMHTTP_DIR/app/bin" "$RCD_DIR"

cp plugin/pages/BayWatch.page "$EMHTTP_DIR/BayWatch.page"
cp plugin/pages/BayWatchDashboard.page "$EMHTTP_DIR/BayWatchDashboard.page"
cp plugin/daemon-control.php "$EMHTTP_DIR/daemon-control.php"
mkdir -p "$EMHTTP_DIR/app/dist"
cp dist/frontend.js "$EMHTTP_DIR/app/dist/frontend.js"
cp dist/dashboard.js "$EMHTTP_DIR/app/dist/dashboard.js"
cp dist/unraid-baywatch "$EMHTTP_DIR/app/bin/${NAME}"
cp plugin/rc.d/rc.unraid-baywatch "$RCD_DIR/rc.${NAME}"
chmod 755 "$EMHTTP_DIR/app/bin/${NAME}" "$RCD_DIR/rc.${NAME}"

ARCHIVE_DIR="$(pwd)/archive"
mkdir -p "$ARCHIVE_DIR"
ARCHIVE_NAME="${NAME}-${VERSION}.txz"
ARCHIVE_PATH="${ARCHIVE_DIR}/${ARCHIVE_NAME}"

echo "--- packing ${ARCHIVE_NAME} ---"
# Reproducible packing: the same source commit should always produce the
# same .txz bytes and the same SHA256, so anyone can rebuild a tagged
# release themselves and confirm the published binary actually matches
# that source, rather than just trusting this CI run (raised as a follow-up
# by the CA security review in #4 - a compiled binary is opaque to review
# regardless of provenance, but a reproducible one is at least checkable).
# --sort=name fixes file order (glob/readdir order isn't guaranteed stable);
# --mtime pins every entry's timestamp to the commit being built instead of
# "whenever this happened to run" (confirmed on a real box's GNU tar 1.35:
# identical content produces an identical archive across separate runs and
# real mtime changes on disk, and a real content change still changes the
# hash). GNU-tar-only flags - CI (ubuntu-latest) has GNU tar, which is what
# matters for real releases; a local macOS run (bsdtar) falls back to a
# plain, non-reproducible archive, which is fine since a local run is never
# what gets shipped (see this file's header comment).
if tar --version 2>/dev/null | grep -q "GNU tar"; then
  tar --owner=root --group=root --mtime="@$(git log -1 --format=%ct)" --sort=name -C "$STAGE" -cJf "$ARCHIVE_PATH" usr/
else
  echo "note: non-GNU tar, packed non-reproducibly (fine for a local test build, not for a real release)"
  tar --owner=root --group=root -C "$STAGE" -cJf "$ARCHIVE_PATH" usr/
fi

if command -v sha256sum >/dev/null 2>&1; then
  SHA256="$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')"
else
  SHA256="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
fi
echo "SHA256: $SHA256"

if ! $RELEASE_MODE; then
  echo "Built $ARCHIVE_PATH (not publishing - pass --release to tag and publish)"
  exit 0
fi

PLG="plugin/${NAME}.plg"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "HEAD" ]] && BRANCH="main" # detached checkout (shouldn't happen for a branch push, but don't push nowhere if it does

# Commit + tag + push, retried against whatever a concurrent release run
# (see pick_version's comment above) already pushed in the meantime. Nothing
# under $STAGE or in the built .txz depends on VERSION's text - only its
# filename and the .plg's own entities do - so re-picking it here and
# renaming the already-built archive is enough; no rebuild needed.
MAX_ATTEMPTS=5
attempt=1
while true; do
  git fetch origin "$BRANCH" --tags >/dev/null 2>&1
  git reset --hard "origin/${BRANCH}" >/dev/null

  VERSION="$(pick_version)"
  NEW_ARCHIVE_PATH="${ARCHIVE_DIR}/${NAME}-${VERSION}.txz"
  [[ "$NEW_ARCHIVE_PATH" != "$ARCHIVE_PATH" ]] && cp "$ARCHIVE_PATH" "$NEW_ARCHIVE_PATH"
  ARCHIVE_PATH="$NEW_ARCHIVE_PATH"

  echo "--- updating plugin/${NAME}.plg (attempt ${attempt}: ${VERSION}) ---"
  sed -i.bak \
    -e "s#<!ENTITY version    \"[^\"]*\">#<!ENTITY version    \"${VERSION}\">#" \
    -e "s#<!ENTITY sha256     \"[^\"]*\">#<!ENTITY sha256     \"${SHA256}\">#" \
    "$PLG"
  rm -f "${PLG}.bak"

  CHANGE_NOTE="$(git log "$(git describe --tags --abbrev=0 2>/dev/null || echo "$(git rev-list --max-parents=0 HEAD)")..HEAD" --pretty='format: - %s' | grep -v '^$' || true)"
  [[ -z "$CHANGE_NOTE" ]] && CHANGE_NOTE=" - Maintenance release."
  python3 - "$PLG" "$VERSION" "$CHANGE_NOTE" <<'PY'
import sys
path, version, notes = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
marker = "<CHANGES>\n"
entry = f"{marker}###{version}\n{notes}\n\n"
text = text.replace(marker, entry, 1)
open(path, "w").write(text)
PY

  git add "$PLG"
  git commit -m "Release ${NAME} ${VERSION}"
  git tag -a "v${VERSION}" -m "${NAME} ${VERSION}"

  # Both refs in one push, so the branch commit and its tag land together
  # rather than leaving a window where another job's pick_version() could
  # see our commit but not yet our tag and pick the same version again.
  if git push origin "HEAD:${BRANCH}" "refs/tags/v${VERSION}"; then
    break
  fi

  git tag -d "v${VERSION}" >/dev/null
  attempt=$((attempt + 1))
  if (( attempt > MAX_ATTEMPTS )); then
    echo "release push rejected ${MAX_ATTEMPTS} times in a row (persistent race or a real problem, not just contention) - giving up" >&2
    exit 1
  fi
  echo "push rejected (another release landed first) - refetching and retrying as attempt ${attempt}/${MAX_ATTEMPTS}"
  sleep $(( (RANDOM % 5) + 2 ))
done

echo "--- publishing GitHub release ---"
if gh release view "v${VERSION}" >/dev/null 2>&1; then
  gh release upload "v${VERSION}" "$ARCHIVE_PATH" --clobber
else
  gh release create "v${VERSION}" "$ARCHIVE_PATH" --title "${VERSION}" --notes "${CHANGE_NOTE}"
fi

echo "Released ${NAME} ${VERSION} (SHA256 ${SHA256})"
