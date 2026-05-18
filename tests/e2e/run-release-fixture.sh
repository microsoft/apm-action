#!/usr/bin/env bash
# E2E harness for `mode: release` dispatch.
#
# Runs the actual compiled action (dist/index.js) against fixture repos with
# release-skip-publish=true. Asserts the artifact set in dist/.
#
# Gated by APM_ACTION_E2E=1 so it does not run in unit-test job.
# Requires: bash, node, and apm CLI (>= 0.13 with --check-versions/--check-clean
# from microsoft/apm PR #1365) on PATH. apm 0.14.0+ once released.

set -euo pipefail

if [[ "${APM_ACTION_E2E:-}" != "1" ]]; then
  echo "Set APM_ACTION_E2E=1 to run this harness."
  exit 0
fi

if ! command -v apm >/dev/null 2>&1; then
  echo "FAIL: apm CLI not on PATH. Install via the apm-action installer or curl install.sh."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node not on PATH."
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST_JS="$REPO_ROOT/dist/index.js"

if [[ ! -f "$DIST_JS" ]]; then
  echo "FAIL: $DIST_JS not found. Run 'npm run build' first."
  exit 1
fi

FAILED=0
PASSED=0

run_scenario() {
  local name="$1"
  local fixture="$2"
  local tag="$3"
  local extra_env="${4:-}"

  echo
  echo "=== Scenario: $name ==="

  local tmp
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN

  cp -R "$REPO_ROOT/tests/fixtures/release/$fixture/." "$tmp/"
  (
    cd "$tmp"
    git init -q
    git config user.email "e2e@example.com"
    git config user.name "e2e"
    git add -A
    git commit -q -m "fixture commit"
    git tag "$tag"
  )

  local outputs_file="$tmp/.outputs"
  local summary_file="$tmp/.summary"
  : > "$outputs_file"
  : > "$summary_file"

  set +e
  env -i \
    HOME="$HOME" \
    PATH="$PATH" \
    INPUT_MODE="release" \
    INPUT_WORKING-DIRECTORY="$tmp" \
    INPUT_RELEASE-TAG="$tag" \
    INPUT_RELEASE-SKIP-PUBLISH="true" \
    INPUT_RELEASE-PRERELEASE="auto" \
    GITHUB_WORKSPACE="$tmp" \
    GITHUB_OUTPUT="$outputs_file" \
    GITHUB_STEP_SUMMARY="$summary_file" \
    GITHUB_REF_NAME="$tag" \
    $extra_env \
    node "$DIST_JS"
  local rc=$?
  set -e

  if [[ $rc -ne 0 ]]; then
    echo "FAIL ($name): action exited with rc=$rc"
    FAILED=$((FAILED + 1))
    return
  fi

  # Check dist contents
  local dist="$tmp/dist"
  if [[ ! -d "$dist" ]]; then
    echo "FAIL ($name): no dist/ directory produced"
    FAILED=$((FAILED + 1))
    return
  fi
  local tarballs sidecars
  tarballs=$(find "$dist" -maxdepth 1 -name '*.tar.gz' | wc -l | tr -d ' ')
  sidecars=$(find "$dist" -maxdepth 1 -name '*.tar.gz.sha256' | wc -l | tr -d ' ')
  echo "  dist/ contents: $tarballs tarball(s), $sidecars sha256 sidecar(s)"
  ls -la "$dist" || true

  if [[ "$tarballs" -lt 1 ]]; then
    echo "FAIL ($name): expected >= 1 tarball, got $tarballs"
    FAILED=$((FAILED + 1))
    return
  fi
  if [[ "$tarballs" != "$sidecars" ]]; then
    echo "FAIL ($name): tarball/sidecar count mismatch ($tarballs vs $sidecars)"
    FAILED=$((FAILED + 1))
    return
  fi

  # Outputs file should have release-tag set
  if ! grep -q "^release-tag<<" "$outputs_file" && ! grep -q "^release-tag=" "$outputs_file"; then
    echo "FAIL ($name): release-tag output not present"
    cat "$outputs_file"
    FAILED=$((FAILED + 1))
    return
  fi

  echo "PASS ($name)"
  PASSED=$((PASSED + 1))
}

run_scenario "aggregator-happy-path" "aggregator" "v1.0.0"
run_scenario "single-plugin-happy-path" "single-plugin" "v1.0.0"

echo
echo "=== Summary ==="
echo "Passed: $PASSED"
echo "Failed: $FAILED"
[[ "$FAILED" -eq 0 ]] || exit 1
