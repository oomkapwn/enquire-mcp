set -euo pipefail
builtin unset -v https_proxy http_proxy all_proxy
GH_CONFIG_DIR=$(/usr/bin/mktemp -d "$RUNNER_TEMP/enquire-gh-config.XXXXXX")
export GH_CONFIG_DIR
CURL_BIN=$(type -P curl)
GH_BIN=$(type -P gh)
TIMEOUT_BIN=$(type -P timeout)
gh_read() {
  if [ "${1:-}" != "api" ]; then
    echo "::error::gh_read accepts read-only gh api calls" >&2
    return 2
  fi
  local argument
  for argument in "$@"; do
    case "$argument" in
      graphql|--method|--method=*|-X*|--input|--input=*|-f*|-F*|--field|--field=*|--raw-field|--raw-field=*)
        echo "::error::gh_read rejects mutation-capable gh api arguments" >&2
        return 2
        ;;
    esac
  done
  if ! [[ "${RELEASE_JOB_DEADLINE_EPOCH:-}" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::Global release deadline is missing or malformed" >&2
    return 2
  fi
  local now remaining
  if ! now=$(/bin/date +%s) || ! [[ "$now" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::Current epoch is unavailable or malformed" >&2
    return 2
  fi
  remaining=$((RELEASE_JOB_DEADLINE_EPOCH - now))
  if [ "$remaining" -le 10 ]; then
    echo "::error::Global 230-minute release deadline reached during a GitHub read" >&2
    return 124
  fi
  local limit=20
  if [ "$limit" -gt $((remaining - 10)) ]; then limit=$((remaining - 10)); fi
  "$TIMEOUT_BIN" --kill-after=5s "${limit}s" "$GH_BIN" "$@"
}
# Return 0 only for one strict published-stable release response, 4
# only for GitHub's exact documented no-latest-release response, and
# 2 for every transport, protocol, header, or JSON ambiguity. Keep
# stdout and stderr separate: matching human-readable gh stderr is
# never authoritative evidence of HTTP absence.
github_latest_read() {
  local gh_exit latest_wire latest_headers latest_body latest_status latest_line
  local latest_content_type="" latest_content_type_count=0 latest_status_count=0
  GITHUB_LATEST_SNAPSHOT=""
  set +e
  latest_wire=$(gh_read api --include \
    --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2022-11-28' \
    "repos/$MCPB_RELEASE_REPOSITORY/releases/latest" 2>/dev/null)
  gh_exit=$?
  set -e
  latest_wire=${latest_wire//$'\r'/}
  if [[ "$latest_wire" != *$'\n\n'* ]]; then
    echo "::warning::GitHub latest-release read lacked one HTTP header/body boundary" >&2
    return 2
  fi
  latest_headers=${latest_wire%%$'\n\n'*}
  latest_body=${latest_wire#*$'\n\n'}
  latest_status=${latest_headers%%$'\n'*}
  while IFS= read -r latest_line; do
    case "$latest_line" in
      HTTP/*)
        latest_status_count=$((latest_status_count + 1))
        ;;
      "Content-Type: "*)
        latest_content_type_count=$((latest_content_type_count + 1))
        latest_content_type=${latest_line#Content-Type: }
        ;;
    esac
  done <<< "$latest_headers"
  if [ "$latest_status_count" -ne 1 ] || [ "$latest_content_type_count" -ne 1 ]; then
    echo "::warning::GitHub latest-release read had an ambiguous HTTP envelope" >&2
    return 2
  fi
  if [ "$gh_exit" -eq 0 ]; then
    if ! [[ "$latest_status" =~ ^HTTP/(1\.1|2\.0)\ 200\ OK$ ]] || \
       [ "$latest_content_type" != "application/json; charset=utf-8" ]; then
      echo "::warning::GitHub latest-release success used an unexpected status or content type" >&2
      return 2
    fi
    if ! GITHUB_LATEST_SNAPSHOT=$(printf '%s' "$latest_body" | /usr/bin/jq -cse \
      'select(length == 1) | .[0] |
      select(type == "object" and .draft == false and .prerelease == false) | {
        id: (.id | select(type == "number" and . > 0 and floor == . and . <= 9007199254740991)),
        tag_name: (.tag_name | select(type == "string" and test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")))
      }'); then
      echo "::warning::GitHub latest-release HTTP 200 body was not one strict stable release" >&2
      return 2
    fi
    return 0
  fi
  if [ "$gh_exit" -eq 1 ] && \
     [[ "$latest_status" =~ ^HTTP/(1\.1|2\.0)\ 404\ Not\ Found$ ]] && \
     [ "$latest_content_type" = "application/json; charset=utf-8" ] && \
     printf '%s' "$latest_body" | /usr/bin/jq -se \
       'length == 1 and (.[0] |
        type == "object" and
        (keys | sort) == ["documentation_url", "message", "status"] and
        .message == "Not Found" and .status == "404" and
        .documentation_url == "https://docs.github.com/rest/releases/releases#get-the-latest-release")' \
       >/dev/null; then
    return 4
  fi
  echo "::warning::GitHub latest-release read was neither strict HTTP 200 nor authoritative HTTP 404" >&2
  return 2
}
VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
ASSET="artifacts/enquire-mcp-basic-$VERSION.mcpb"
CONTENT="artifacts/enquire-mcp-basic-$VERSION.content-manifest.json"
SBOM="artifacts/enquire-mcp-basic-$VERSION.sbom.cdx.json"
LICENSES="artifacts/enquire-mcp-basic-$VERSION.third-party-licenses.json"
SOURCE_SHA=$(git rev-parse HEAD)
EXPECTED_PRERELEASE=false
if [ "$MCPB_RELEASE_CHANNEL" != "latest" ]; then
  EXPECTED_PRERELEASE=true
fi
NOTES=$(awk -v heading="## [$VERSION] — " '
  index($0, heading) == 1 { capture=1; next }
  capture && /^## \[/ { exit }
  capture { print }
' CHANGELOG.md)
if [ -z "$NOTES" ]; then
  NOTES="See [CHANGELOG.md](https://github.com/$MCPB_RELEASE_REPOSITORY/blob/main/CHANGELOG.md) for full release notes."
fi
release_state() {
  EXPECTED_RELEASE_NAME="$TAG" EXPECTED_RELEASE_BODY="$NOTES" \
    node scripts/check-release-integrity.mjs release-state "$TAG" "$EXPECTED_PRERELEASE" \
    "$(basename "$ASSET")" "$(basename "$ASSET.sha256")" "$(basename "$CONTENT")" \
    "$(basename "$SBOM")" "$(basename "$LICENSES")" "$(basename "$ASSET.provenance.json")"
}
assert_remote_tag_identity() {
  if ! TAG_REF_JSON=$(gh_read api \
    "repos/$MCPB_RELEASE_REPOSITORY/git/ref/tags/$TAG"); then
    echo "::error::Exact-repository tag ref $TAG is unreadable"
    exit 1
  fi
  if ! TAG_OBJECT_SHA=$(printf '%s' "$TAG_REF_JSON" | jq -er --arg ref "refs/tags/$TAG" \
    'select(type == "object" and .ref == $ref) | .object |
     select(type == "object" and .type == "tag") | .sha |
     select(type == "string" and test("^[0-9a-f]{40}$"))'); then
    echo "::error::Exact-repository ref $TAG is not one annotated-tag object"
    exit 1
  fi
  if ! TAG_OBJECT_JSON=$(gh_read api \
    "repos/$MCPB_RELEASE_REPOSITORY/git/tags/$TAG_OBJECT_SHA"); then
    echo "::error::Annotated-tag object $TAG_OBJECT_SHA is unreadable"
    exit 1
  fi
  if ! printf '%s' "$TAG_OBJECT_JSON" | jq -e --arg tag "$TAG" --arg sha "$SOURCE_SHA" \
    --arg tag_object_sha "$TAG_OBJECT_SHA" \
    'select(type == "object" and .sha == $tag_object_sha and .tag == $tag) | .object |
     select(type == "object" and .type == "commit" and .sha == $sha)' >/dev/null; then
    echo "::error::Exact-repository tag $TAG must peel to exact source SHA $SOURCE_SHA"
    exit 1
  fi
  if ! TAG_REF_CONFIRM_JSON=$(gh_read api \
    "repos/$MCPB_RELEASE_REPOSITORY/git/ref/tags/$TAG") || \
     ! printf '%s' "$TAG_REF_CONFIRM_JSON" | jq -e --arg ref "refs/tags/$TAG" \
       --arg sha "$TAG_OBJECT_SHA" \
       'select(type == "object" and .ref == $ref) | .object |
        select(type == "object" and .type == "tag" and .sha == $sha)' >/dev/null; then
    echo "::error::Exact-repository tag ref $TAG changed during identity proof"
    exit 1
  fi
}
require_job_reserve() {
  local required="$1"
  local label="$2"
  if ! [[ "${RELEASE_JOB_DEADLINE_EPOCH:-}" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::Global release deadline is missing or malformed" >&2
    exit 1
  fi
  local now remaining
  if ! now=$(/bin/date +%s) || ! [[ "$now" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::Current epoch is unavailable or malformed" >&2
    return 2
  fi
  remaining=$((RELEASE_JOB_DEADLINE_EPOCH - now))
  if [ "$remaining" -lt "$required" ]; then
    echo "::error::$label requires ${required}s of post-write reserve; only ${remaining}s remain"
    exit 1
  fi
}
refresh_exact_release_assets() {
  local label="$1"
  if ! CURRENT_RELEASE=$(gh_read api "repos/$MCPB_RELEASE_REPOSITORY/releases/$RELEASE_ID") || \
     ! CURRENT_ASSET_PAGES=$(gh_read api --paginate --slurp \
       "repos/$MCPB_RELEASE_REPOSITORY/releases/$RELEASE_ID/assets?per_page=100"); then
    echo "::warning::$label returned an unreadable exact-release snapshot"
    return 1
  fi
  if ! CURRENT_ASSETS=$(printf '%s' "$CURRENT_ASSET_PAGES" | node \
    scripts/check-release-integrity.mjs flatten-pages asset) || \
     ! CURRENT_ID=$(printf '%s' "$CURRENT_RELEASE" | jq -er \
       '.id | select(type == "number" and . > 0 and floor == . and . <= 9007199254740991) | tostring') || \
     ! CURRENT_TAG=$(printf '%s' "$CURRENT_RELEASE" | jq -er \
       '.tag_name | select(type == "string" and length > 0)') || \
     ! CURRENT_PRERELEASE=$(printf '%s' "$CURRENT_RELEASE" | jq -er \
       '.prerelease | select(type == "boolean") | tostring') || \
     ! CURRENT_DRAFT=$(printf '%s' "$CURRENT_RELEASE" | jq -er \
       '.draft | select(type == "boolean") | tostring'); then
    echo "::warning::$label returned a malformed exact-release snapshot"
    return 1
  fi
  if [ "$CURRENT_ID" != "$RELEASE_ID" ] || [ "$CURRENT_TAG" != "$TAG" ] || \
     [ "$CURRENT_PRERELEASE" != "$EXPECTED_PRERELEASE" ] || \
     { [ "$CURRENT_DRAFT" != "true" ] && [ "$CURRENT_DRAFT" != "false" ]; }; then
    echo "::error::$label returned a divergent exact-release identity"
    exit 1
  fi
}
confirm_exact_draft_identity() {
  local label="$1"
  if ! CONFIRM_ASSET_PAGES=$(gh_read api --paginate --slurp \
    "repos/$MCPB_RELEASE_REPOSITORY/releases/$RELEASE_ID/assets?per_page=100") || \
     ! CONFIRM_RELEASE=$(gh_read api \
       "repos/$MCPB_RELEASE_REPOSITORY/releases/$RELEASE_ID"); then
    echo "::error::$label exact release/asset snapshot is unreadable"
    return 1
  fi
  if ! CONFIRM_ASSETS=$(printf '%s' "$CONFIRM_ASSET_PAGES" | node \
    scripts/check-release-integrity.mjs flatten-pages asset) || \
     ! CONFIRM_ID=$(printf '%s' "$CONFIRM_RELEASE" | jq -er \
    '.id | select(type == "number" and . > 0 and floor == . and . <= 9007199254740991) | tostring') || \
     ! CONFIRM_TAG=$(printf '%s' "$CONFIRM_RELEASE" | jq -er \
       '.tag_name | select(type == "string" and length > 0)') || \
     ! CONFIRM_PRERELEASE=$(printf '%s' "$CONFIRM_RELEASE" | jq -er \
       '.prerelease | select(type == "boolean") | tostring') || \
     ! CONFIRM_DRAFT=$(printf '%s' "$CONFIRM_RELEASE" | jq -er \
       '.draft | select(type == "boolean") | tostring') || \
     ! CONFIRM_UPLOAD_URL=$(printf '%s' "$CONFIRM_RELEASE" | jq -er \
       '.upload_url | select(type == "string" and length > 0)'); then
    echo "::error::$label exact release/asset snapshot is malformed"
    return 1
  fi
  if [ "$CONFIRM_ID" != "$RELEASE_ID" ] || [ "$CONFIRM_TAG" != "$TAG" ] || \
     [ "$CONFIRM_PRERELEASE" != "$EXPECTED_PRERELEASE" ] || [ "$CONFIRM_DRAFT" != "true" ]; then
    echo "::error::$label no longer identifies the exact resumable draft"
    return 1
  fi
}
download_exact_release_asset() {
  local remote_id="$1"
  local local_asset="$2"
  local target="$3"
  local label="$4"
  if [ -e "$target" ]; then
    echo "::error::Remote comparison target already exists: $target"
    return 1
  fi
  for (( binary_attempt=1; binary_attempt<=6; binary_attempt++ )); do
    local attempt_asset="$target.attempt-$binary_attempt"
    if [ -e "$attempt_asset" ]; then
      echo "::error::Remote asset attempt target already exists: $attempt_asset"
      return 1
    fi
    if gh_read api -H "Accept: application/octet-stream" \
      "repos/$MCPB_RELEASE_REPOSITORY/releases/assets/$remote_id" > "$attempt_asset"; then
      if ! cmp -s "$local_asset" "$attempt_asset"; then
        echo "::error::Release asset $label differs from the canonical CI-gated bytes"
        return 1
      fi
      mv "$attempt_asset" "$target"
      return 0
    fi
    if [ "$binary_attempt" -eq 6 ]; then
      echo "::error::Release asset $label did not become downloadable after 6 bounded checks"
      return 1
    fi
    echo "::warning::Release asset $label is not downloadable (attempt $binary_attempt/6); retrying in 5s"
    sleep 5
  done
}
assert_remote_tag_identity
IDENTITY_DIR=".mcpb-release-assets-$GITHUB_RUN_ID"
if [ -e "$IDENTITY_DIR" ]; then
  echo "::error::release-asset identity path already exists: $IDENTITY_DIR"
  exit 1
fi
mkdir "$IDENTITY_DIR"
# A newly created draft can be briefly absent from list-releases.
# Retry only the zero-result state; duplicates still fail immediately.
RELEASE_COUNT=0
for (( release_attempt=1; release_attempt<=12; release_attempt++ )); do
  if ! RELEASE_PAGES=$(gh_read api --paginate --slurp \
    "repos/$MCPB_RELEASE_REPOSITORY/releases?per_page=100"); then
    if [ "$release_attempt" -eq 12 ]; then
      echo "::error::Release $TAG remained unreadable after 12 bounded checks"
      exit 1
    fi
    echo "::warning::Release list read failed (attempt $release_attempt/12); retrying in 5s"
    sleep 5
    continue
  fi
  RELEASES=$(printf '%s' "$RELEASE_PAGES" | node scripts/check-release-integrity.mjs \
    flatten-pages release)
  RELEASE_COUNT=$(printf '%s' "$RELEASES" | jq --arg tag "$TAG" \
    '[.[] | select(.tag_name == $tag)] | length')
  if [ "$RELEASE_COUNT" -gt 1 ]; then
    echo "::error::Asset phase found duplicate draft/published releases for $TAG"
    exit 1
  fi
  if [ "$RELEASE_COUNT" -eq 1 ]; then break; fi
  if [ "$release_attempt" -eq 12 ]; then
    echo "::error::Release $TAG did not become visible after 12 bounded checks"
    exit 1
  fi
  echo "::warning::Release $TAG is not visible yet (attempt $release_attempt/12); retrying in 5s"
  sleep 5
done
RELEASE_JSON=$(printf '%s' "$RELEASES" | jq --arg tag "$TAG" \
  '.[] | select(.tag_name == $tag)')
RELEASE_ID=$(printf '%s' "$RELEASE_JSON" | jq -er \
  '.id | select(type == "number" and . > 0 and floor == . and . <= 9007199254740991)')
RELEASE_PRERELEASE=$(printf '%s' "$RELEASE_JSON" | jq -r '.prerelease')
RELEASE_DRAFT=$(printf '%s' "$RELEASE_JSON" | jq -r '.draft')
if [ "$RELEASE_PRERELEASE" != "$EXPECTED_PRERELEASE" ] || \
   { [ "$RELEASE_DRAFT" != "true" ] && [ "$RELEASE_DRAFT" != "false" ]; }; then
  echo "::error::Release identity changed before asset verification"
  exit 1
fi
ASSET_PAGES=$(gh_read api --paginate --slurp \
  "repos/$MCPB_RELEASE_REPOSITORY/releases/$RELEASE_ID/assets?per_page=100")
REMOTE_ASSETS=$(printf '%s' "$ASSET_PAGES" | node scripts/check-release-integrity.mjs \
  flatten-pages asset)
RELEASE_STATE=$(jq -n --argjson release "$RELEASE_JSON" --argjson assets "$REMOTE_ASSETS" \
  '{release: $release, assets: $assets}')
RELEASE_ACTION=$(printf '%s' "$RELEASE_STATE" | release_state | jq -r '.action')
ACTUAL_COUNT=$(printf '%s' "$REMOTE_ASSETS" | jq 'length')
while IFS= read -r REMOTE_NAME; do
  if [ "$REMOTE_NAME" != "$(basename "$ASSET")" ] && \
     [ "$REMOTE_NAME" != "$(basename "$ASSET.sha256")" ] && \
     [ "$REMOTE_NAME" != "$(basename "$CONTENT")" ] && \
     [ "$REMOTE_NAME" != "$(basename "$SBOM")" ] && \
     [ "$REMOTE_NAME" != "$(basename "$LICENSES")" ] && \
     [ "$REMOTE_NAME" != "$(basename "$ASSET.provenance.json")" ]; then
    echo "::error::Release $TAG contains unexpected asset $REMOTE_NAME"
    exit 1
  fi
done < <(printf '%s' "$REMOTE_ASSETS" | jq -r '.[].name')
if [ "$RELEASE_DRAFT" = "false" ] && [ "$ACTUAL_COUNT" -ne 6 ]; then
  echo "::error::Published release $TAG is partial; refusing to mutate an externally visible release"
  exit 1
fi
# Freeze the canonical local projection and verify every already
# visible remote asset before authorizing any new upload.
LOCAL_ASSET_PROJECTION='[]'
for LOCAL_ASSET in "$ASSET" "$ASSET.sha256" "$CONTENT" "$SBOM" "$LICENSES" "$ASSET.provenance.json"; do
  if [ ! -f "$LOCAL_ASSET" ] || [ -L "$LOCAL_ASSET" ]; then
    echo "::error::Release asset is missing, non-regular, or a symlink: $LOCAL_ASSET"
    exit 1
  fi
  NAME=$(basename "$LOCAL_ASSET")
  LOCAL_SIZE=$(wc -c < "$LOCAL_ASSET" | tr -d '[:space:]')
  LOCAL_DIGEST="sha256:$(sha256sum "$LOCAL_ASSET" | awk '{print $1}')"
  if ! [[ "$LOCAL_SIZE" =~ ^[1-9][0-9]*$ ]] || \
     ! [[ "$LOCAL_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "::error::Canonical local release asset has an invalid size or digest: $NAME"
    exit 1
  fi
  LOCAL_ASSET_PROJECTION=$(printf '%s' "$LOCAL_ASSET_PROJECTION" | jq -c \
    --arg name "$NAME" --argjson size "$LOCAL_SIZE" --arg digest "$LOCAL_DIGEST" \
    '. + [{name: $name, content_type: "application/octet-stream", size: $size, digest: $digest}]')
  MATCH_COUNT=$(printf '%s' "$REMOTE_ASSETS" | jq --arg name "$NAME" \
    '[.[] | select(.name == $name)] | length')
  if [ "$MATCH_COUNT" -gt 1 ]; then
    echo "::error::Release $TAG contains duplicate asset name $NAME"
    exit 1
  fi
  if [ "$MATCH_COUNT" -eq 1 ]; then
    REMOTE_STATE=$(printf '%s' "$REMOTE_ASSETS" | jq -r --arg name "$NAME" \
      '.[] | select(.name == $name) | .state')
    REMOTE_CONTENT_TYPE=$(printf '%s' "$REMOTE_ASSETS" | jq -r --arg name "$NAME" \
      '.[] | select(.name == $name) | .content_type')
    REMOTE_SIZE=$(printf '%s' "$REMOTE_ASSETS" | jq -r --arg name "$NAME" \
      '.[] | select(.name == $name) | .size')
    REMOTE_DIGEST=$(printf '%s' "$REMOTE_ASSETS" | jq -r --arg name "$NAME" \
      '.[] | select(.name == $name) | .digest')
    if [ "$REMOTE_STATE" != "uploaded" ] || \
       [ "$REMOTE_CONTENT_TYPE" != "application/octet-stream" ] || \
       [ "$REMOTE_SIZE" != "$LOCAL_SIZE" ] || [ "$REMOTE_DIGEST" != "$LOCAL_DIGEST" ]; then
      echo "::error::Existing release asset metadata differs from canonical local bytes for $NAME; manual recovery required"
      exit 1
    fi
    REMOTE_ID=$(printf '%s' "$REMOTE_ASSETS" | jq -r --arg name "$NAME" \
      '.[] | select(.name == $name) | .id')
    download_exact_release_asset "$REMOTE_ID" "$LOCAL_ASSET" "$IDENTITY_DIR/$NAME" "$NAME preflight"
  fi
done
LOCAL_ASSET_PROJECTION=$(printf '%s' "$LOCAL_ASSET_PROJECTION" | jq -cS 'sort_by(.name)')

for LOCAL_ASSET in "$ASSET" "$ASSET.sha256" "$CONTENT" "$SBOM" "$LICENSES" "$ASSET.provenance.json"; do
  NAME=$(basename "$LOCAL_ASSET")
  if [ -e "$IDENTITY_DIR/$NAME" ]; then
    echo "Verified exact existing release asset: $NAME"
    continue
  fi
  LOCAL_SIZE=$(printf '%s' "$LOCAL_ASSET_PROJECTION" | jq -er --arg name "$NAME" \
    '.[] | select(.name == $name) | .size')
  LOCAL_DIGEST=$(printf '%s' "$LOCAL_ASSET_PROJECTION" | jq -er --arg name "$NAME" \
    '.[] | select(.name == $name) | .digest')
  MATCH_COUNT=0
  ASSET_ABSENCE_OBSERVATIONS=0
  for (( absence_attempt=1; absence_attempt<=12; absence_attempt++ )); do
    if ! refresh_exact_release_assets "Pre-upload reconciliation for $NAME"; then
      if [ "$absence_attempt" -eq 12 ]; then
        echo "::error::Pre-upload reconciliation for $NAME remained unreadable"
        exit 1
      fi
      sleep 5
      continue
    fi
    CURRENT_STATE=$(jq -n --argjson release "$CURRENT_RELEASE" --argjson assets "$CURRENT_ASSETS" \
      '{release: $release, assets: $assets}')
    CURRENT_ACTION=$(printf '%s' "$CURRENT_STATE" | release_state | jq -r '.action')
    CURRENT_NAME_COUNT=$(printf '%s' "$CURRENT_ASSETS" | jq --arg name "$NAME" \
      '[.[] | select(.name == $name)] | length')
    if [ "$CURRENT_NAME_COUNT" -gt 1 ]; then
      echo "::error::Release $TAG contains duplicate asset name $NAME"
      exit 1
    fi
    if [ "$CURRENT_NAME_COUNT" -eq 1 ]; then
      REMOTE_ASSETS=$CURRENT_ASSETS
      MATCH_COUNT=1
      echo "Recovered already accepted release asset $NAME before a repeated write"
      break
    fi
    if [ "$CURRENT_ACTION" != "resume_draft" ]; then
      echo "::error::Release $TAG is not a resumable draft before uploading $NAME"
      exit 1
    fi
    ASSET_ABSENCE_OBSERVATIONS=$((ASSET_ABSENCE_OBSERVATIONS + 1))
    if [ "$ASSET_ABSENCE_OBSERVATIONS" -eq 6 ]; then break; fi
    echo "::warning::Asset $NAME remains absent ($ASSET_ABSENCE_OBSERVATIONS/6 confirmations); retrying in 5s"
    sleep 5
  done
  if [ "$MATCH_COUNT" -eq 0 ]; then
    if [ "$ASSET_ABSENCE_OBSERVATIONS" -ne 6 ]; then
      echo "::error::Asset $NAME absence was not confirmed before upload"
      exit 1
    fi
    ENCODED_NAME=$(printf '%s' "$NAME" | jq -sRr @uri)
    UPLOAD_RESPONSE="$IDENTITY_DIR/.upload-response-$NAME.json"
    if [ -e "$UPLOAD_RESPONSE" ]; then
      echo "::error::Upload response target already exists: $UPLOAD_RESPONSE"
      exit 1
    fi
    require_job_reserve 1500 "release asset upload for $NAME"
    assert_remote_tag_identity
    if ! refresh_exact_release_assets "Immediate pre-upload reconciliation for $NAME"; then
      echo "::error::Immediate pre-upload release snapshot is not authoritative for $NAME"
      exit 1
    fi
    PREWRITE_STATE=$(jq -n --argjson release "$CURRENT_RELEASE" --argjson assets "$CURRENT_ASSETS" \
      '{release: $release, assets: $assets}')
    PREWRITE_ACTION=$(printf '%s' "$PREWRITE_STATE" | release_state | jq -r '.action')
    PREWRITE_NAME_COUNT=$(printf '%s' "$CURRENT_ASSETS" | jq --arg name "$NAME" \
      '[.[] | select(.name == $name)] | length')
    if [ "$PREWRITE_ACTION" != "resume_draft" ] || [ "$PREWRITE_NAME_COUNT" -ne 0 ]; then
      echo "::error::Exact release is no longer one resumable draft with absent asset $NAME; refusing POST"
      exit 1
    fi
    PREWRITE_ASSET_PROJECTION=$(printf '%s' "$CURRENT_ASSETS" | jq -cS \
      '[.[] | {name, content_type, size, digest}] | sort_by(.name)')
    PREWRITE_LOCAL_SUBSET=$(jq -cn --argjson local "$LOCAL_ASSET_PROJECTION" \
      --argjson remote "$CURRENT_ASSETS" \
      '[$local[] | . as $candidate | select(any($remote[]; .name == $candidate.name))] | sort_by(.name)')
    if [ "$PREWRITE_ASSET_PROJECTION" != "$PREWRITE_LOCAL_SUBSET" ]; then
      echo "::error::Existing release assets changed from the canonical local projection before POST"
      exit 1
    fi
    EXPECTED_UPLOAD_URL="https://uploads.github.com/repos/$MCPB_RELEASE_REPOSITORY/releases/$RELEASE_ID/assets{?name,label}"
    if ! confirm_exact_draft_identity "Immediate pre-upload confirmation for $NAME"; then
      exit 1
    fi
    CONFIRM_STATE=$(jq -n --argjson release "$CONFIRM_RELEASE" --argjson assets "$CONFIRM_ASSETS" \
      '{release: $release, assets: $assets}')
    CONFIRM_ACTION=$(printf '%s' "$CONFIRM_STATE" | release_state | jq -r '.action')
    CONFIRM_NAME_COUNT=$(printf '%s' "$CONFIRM_ASSETS" | jq --arg name "$NAME" \
      '[.[] | select(.name == $name)] | length')
    CONFIRM_ASSET_PROJECTION=$(printf '%s' "$CONFIRM_ASSETS" | jq -cS \
      '[.[] | {name, content_type, size, digest}] | sort_by(.name)')
    CONFIRM_LOCAL_SUBSET=$(jq -cn --argjson local "$LOCAL_ASSET_PROJECTION" \
      --argjson remote "$CONFIRM_ASSETS" \
      '[$local[] | . as $candidate | select(any($remote[]; .name == $candidate.name))] | sort_by(.name)')
    if [ "$CONFIRM_ACTION" != "resume_draft" ] || [ "$CONFIRM_NAME_COUNT" -ne 0 ] || \
       [ "$CONFIRM_ASSET_PROJECTION" != "$CONFIRM_LOCAL_SUBSET" ]; then
      echo "::error::Final pre-upload snapshot is not the exact resumable draft with absent $NAME"
      exit 1
    fi
    if [ "$CONFIRM_UPLOAD_URL" != "$EXPECTED_UPLOAD_URL" ]; then
      echo "::error::GitHub release upload URL is not bound to the exact repository and release ID"
      exit 1
    fi
    # Re-hash only after the final authoritative remote snapshot and
    # directly before the irreversible upload boundary.
    if [ ! -f "$LOCAL_ASSET" ] || [ -L "$LOCAL_ASSET" ] || \
       [ "$(wc -c < "$LOCAL_ASSET" | tr -d '[:space:]')" != "$LOCAL_SIZE" ] || \
       [ "sha256:$(sha256sum "$LOCAL_ASSET" | awk '{print $1}')" != "$LOCAL_DIGEST" ]; then
      echo "::error::Canonical local release asset changed before upload: $NAME"
      exit 1
    fi
    UPLOAD_BASE=${CONFIRM_UPLOAD_URL%%\{*}
    UPLOAD_EXIT=0
    set +e
    UPLOAD_STATUS=$("$TIMEOUT_BIN" --kill-after=10s 310s "$CURL_BIN" --disable \
      --fail-with-body --silent --show-error --request POST --retry 0 \
      --proxy '' --proto '=https' --tlsv1.2 --max-redirs 0 \
      --connect-timeout 10 --max-time 300 --max-filesize 1048576 \
      -H "Authorization: Bearer $GH_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "Content-Type: application/octet-stream" \
      --data-binary "@$LOCAL_ASSET" --output "$UPLOAD_RESPONSE" --write-out '%{http_code}' \
      "$UPLOAD_BASE?name=$ENCODED_NAME")
    UPLOAD_EXIT=$?
    set -e
    UPLOAD_RESPONSE_PROVED=false
    if [ "$UPLOAD_EXIT" -eq 0 ] && [ "$UPLOAD_STATUS" = "201" ]; then
      if UPLOADED_ASSET=$(jq -ce \
        'select(type == "object") | {
          id: (.id | select(type == "number" and . > 0 and floor == . and . <= 9007199254740991)),
          name: (.name | select(type == "string" and length > 0)),
          state: (.state | select(type == "string" and length > 0)),
          content_type: (.content_type | select(type == "string" and length > 0)),
          size: (.size | select(type == "number" and . >= 0 and floor == . and . <= 9007199254740991)),
          digest: (.digest | select(type == "string" and test("^sha256:[0-9a-f]{64}$")))
        }' "$UPLOAD_RESPONSE"); then
        UPLOADED_NAME=$(printf '%s' "$UPLOADED_ASSET" | jq -r '.name')
        UPLOADED_STATE=$(printf '%s' "$UPLOADED_ASSET" | jq -r '.state')
        UPLOADED_CONTENT_TYPE=$(printf '%s' "$UPLOADED_ASSET" | jq -r '.content_type')
        UPLOADED_SIZE=$(printf '%s' "$UPLOADED_ASSET" | jq -r '.size')
        UPLOADED_DIGEST=$(printf '%s' "$UPLOADED_ASSET" | jq -r '.digest')
        if [ "$UPLOADED_NAME" != "$NAME" ] || [ "$UPLOADED_STATE" != "uploaded" ] || \
           [ "$UPLOADED_CONTENT_TYPE" != "application/octet-stream" ] || \
           [ "$UPLOADED_SIZE" != "$LOCAL_SIZE" ] || [ "$UPLOADED_DIGEST" != "$LOCAL_DIGEST" ]; then
          echo "::error::Upload response contradicts the canonical asset identity for $NAME; manual recovery required"
          exit 1
        fi
        REMOTE_ASSETS=$(jq -n --argjson current "$CURRENT_ASSETS" --argjson uploaded "$UPLOADED_ASSET" \
          '$current + [$uploaded]')
        UPLOAD_STATE=$(jq -n --argjson release "$CURRENT_RELEASE" --argjson assets "$REMOTE_ASSETS" \
          '{release: $release, assets: $assets}')
        printf '%s' "$UPLOAD_STATE" | release_state >/dev/null
        MATCH_COUNT=1
        UPLOAD_RESPONSE_PROVED=true
      else
        echo "::warning::Upload response was malformed; requiring exact-name reconciliation without repeating POST"
      fi
    elif [ "$UPLOAD_STATUS" != "" ] && [ "$UPLOAD_STATUS" != "000" ] && \
         [ "$UPLOAD_STATUS" != "201" ] && [ "$UPLOAD_STATUS" != "408" ] && \
         [ "$UPLOAD_STATUS" != "409" ] && [ "$UPLOAD_STATUS" != "422" ] && \
         [ "$UPLOAD_STATUS" != "429" ] && ! [[ "$UPLOAD_STATUS" =~ ^5[0-9][0-9]$ ]]; then
      echo "::error::Release asset upload failed unambiguously: curl=$UPLOAD_EXIT HTTP=$UPLOAD_STATUS"
      exit 1
    fi
    if [ "$UPLOAD_RESPONSE_PROVED" != "true" ]; then
      echo "::warning::Release asset upload result is ambiguous; reconciling exact name without repeating POST"
      for (( upload_recovery_attempt=1; upload_recovery_attempt<=12; upload_recovery_attempt++ )); do
        if ! refresh_exact_release_assets "Post-upload reconciliation for $NAME"; then
          if [ "$upload_recovery_attempt" -eq 12 ]; then
            echo "::error::Post-upload reconciliation for $NAME remained unreadable"
            exit 1
          fi
          sleep 5
          continue
        fi
        RECOVERY_NAME_COUNT=$(printf '%s' "$CURRENT_ASSETS" | jq --arg name "$NAME" \
          '[.[] | select(.name == $name)] | length')
        if [ "$RECOVERY_NAME_COUNT" -gt 1 ]; then
          echo "::error::Ambiguous upload produced duplicate asset name $NAME; manual recovery required"
          exit 1
        fi
        if [ "$RECOVERY_NAME_COUNT" -eq 1 ]; then
          RECOVERED_STATE=$(printf '%s' "$CURRENT_ASSETS" | jq -r --arg name "$NAME" \
            '.[] | select(.name == $name) | .state')
          RECOVERED_CONTENT_TYPE=$(printf '%s' "$CURRENT_ASSETS" | jq -r --arg name "$NAME" \
            '.[] | select(.name == $name) | .content_type')
          RECOVERED_SIZE=$(printf '%s' "$CURRENT_ASSETS" | jq -r --arg name "$NAME" \
            '.[] | select(.name == $name) | .size')
          RECOVERED_DIGEST=$(printf '%s' "$CURRENT_ASSETS" | jq -r --arg name "$NAME" \
            '.[] | select(.name == $name) | .digest')
          if [ "$RECOVERED_STATE" != "uploaded" ]; then
            echo "::error::Ambiguous upload left asset $NAME in state $RECOVERED_STATE; manual recovery required"
            exit 1
          fi
          if [ "$RECOVERED_CONTENT_TYPE" != "application/octet-stream" ] || \
             [ "$RECOVERED_SIZE" != "$LOCAL_SIZE" ] || [ "$RECOVERED_DIGEST" != "$LOCAL_DIGEST" ]; then
            echo "::error::Ambiguous upload exposed divergent metadata for $NAME; manual recovery required"
            exit 1
          fi
          RECOVERY_STATE=$(jq -n --argjson release "$CURRENT_RELEASE" --argjson assets "$CURRENT_ASSETS" \
            '{release: $release, assets: $assets}')
          printf '%s' "$RECOVERY_STATE" | release_state >/dev/null
          REMOTE_ASSETS=$CURRENT_ASSETS
          MATCH_COUNT=1
          echo "Recovered exact release asset $NAME after an ambiguous upload response"
          break
        fi
        if [ "$upload_recovery_attempt" -eq 12 ]; then
          echo "::error::Ambiguous upload never exposed exact asset $NAME; refusing a repeated POST"
          exit 1
        fi
        sleep 5
      done
    fi
    assert_remote_tag_identity
  fi
  if [ "$MATCH_COUNT" -ne 1 ]; then
    echo "::error::Release asset $NAME did not resolve to one exact identity"
    exit 1
  fi
  REMOTE_STATE=$(printf '%s' "$REMOTE_ASSETS" | jq -r --arg name "$NAME" \
    '.[] | select(.name == $name) | .state')
  REMOTE_CONTENT_TYPE=$(printf '%s' "$REMOTE_ASSETS" | jq -r --arg name "$NAME" \
    '.[] | select(.name == $name) | .content_type')
  REMOTE_SIZE=$(printf '%s' "$REMOTE_ASSETS" | jq -r --arg name "$NAME" \
    '.[] | select(.name == $name) | .size')
  REMOTE_DIGEST=$(printf '%s' "$REMOTE_ASSETS" | jq -r --arg name "$NAME" \
    '.[] | select(.name == $name) | .digest')
  if [ "$REMOTE_STATE" != "uploaded" ] || \
     [ "$REMOTE_CONTENT_TYPE" != "application/octet-stream" ] || \
     [ "$REMOTE_SIZE" != "$LOCAL_SIZE" ] || [ "$REMOTE_DIGEST" != "$LOCAL_DIGEST" ]; then
    echo "::error::Release asset metadata differs from canonical local bytes for $NAME"
    exit 1
  fi
  REMOTE_ID=$(printf '%s' "$REMOTE_ASSETS" | jq -r --arg name "$NAME" \
    '.[] | select(.name == $name) | .id')
  download_exact_release_asset "$REMOTE_ID" "$LOCAL_ASSET" "$IDENTITY_DIR/$NAME" "$NAME"
  echo "Verified exact release asset: $NAME"
done
for (( asset_set_attempt=1; asset_set_attempt<=12; asset_set_attempt++ )); do
  if ! refresh_exact_release_assets "Final release asset reconciliation"; then
    if [ "$asset_set_attempt" -eq 12 ]; then
      echo "::error::Final release asset collection remained unreadable after 12 bounded checks"
      exit 1
    fi
    sleep 5
    continue
  fi
  FINAL_ASSETS=$CURRENT_ASSETS
  FINAL_RELEASE=$CURRENT_RELEASE
  FINAL_STATE=$(jq -n --argjson release "$FINAL_RELEASE" --argjson assets "$FINAL_ASSETS" \
    '{release: $release, assets: $assets}')
  FINAL_ACTION=$(printf '%s' "$FINAL_STATE" | release_state | jq -r '.action')
  FINAL_COUNT=$(printf '%s' "$FINAL_ASSETS" | jq 'length')
  ASSET_SET_ACTION=$(node scripts/check-release-integrity.mjs visibility \
    "$FINAL_COUNT" 6 "$asset_set_attempt" 12 "release $TAG asset set" | jq -r '.action')
  if [ "$ASSET_SET_ACTION" = "ready" ]; then break; fi
  if [ "$FINAL_ACTION" != "resume_draft" ]; then
    echo "::error::Release $TAG changed state while its asset collection was converging"
    exit 1
  fi
  echo "::warning::Release $TAG asset list is incomplete (attempt $asset_set_attempt/12); retrying in 5s"
  sleep 5
done
FINAL_LOCAL_PROJECTION=$(printf '%s' "$FINAL_ASSETS" | jq -cS \
  '[.[] | {name, content_type, size, digest}] | sort_by(.name)')
if [ "$FINAL_LOCAL_PROJECTION" != "$LOCAL_ASSET_PROJECTION" ]; then
  echo "::error::Final release metadata differs from the canonical local six-asset projection"
  exit 1
fi
FINAL_DIR=".mcpb-release-final-$GITHUB_RUN_ID"
if [ -e "$FINAL_DIR" ]; then
  echo "::error::Final release identity path already exists: $FINAL_DIR"
  exit 1
fi
mkdir "$FINAL_DIR"
while IFS= read -r REMOTE_NAME; do
  if [ "$REMOTE_NAME" != "$(basename "$ASSET")" ] && \
     [ "$REMOTE_NAME" != "$(basename "$ASSET.sha256")" ] && \
     [ "$REMOTE_NAME" != "$(basename "$CONTENT")" ] && \
     [ "$REMOTE_NAME" != "$(basename "$SBOM")" ] && \
     [ "$REMOTE_NAME" != "$(basename "$LICENSES")" ] && \
     [ "$REMOTE_NAME" != "$(basename "$ASSET.provenance.json")" ]; then
    echo "::error::Final release contains unexpected asset $REMOTE_NAME"
    exit 1
  fi
done < <(printf '%s' "$FINAL_ASSETS" | jq -r '.[].name')
for LOCAL_ASSET in "$ASSET" "$ASSET.sha256" "$CONTENT" "$SBOM" "$LICENSES" "$ASSET.provenance.json"; do
  NAME=$(basename "$LOCAL_ASSET")
  MATCH_COUNT=$(printf '%s' "$FINAL_ASSETS" | jq --arg name "$NAME" \
    '[.[] | select(.name == $name)] | length')
  if [ "$MATCH_COUNT" -ne 1 ]; then
    echo "::error::Final release does not contain exactly one $NAME"
    exit 1
  fi
  REMOTE_ID=$(printf '%s' "$FINAL_ASSETS" | jq -r --arg name "$NAME" \
    '.[] | select(.name == $name) | .id')
  download_exact_release_asset "$REMOTE_ID" "$LOCAL_ASSET" "$FINAL_DIR/$NAME" "$NAME final pass"
done
FINAL_ASSET_IDENTITY=$(printf '%s' "$FINAL_ASSETS" | jq -cS \
  '[.[] | {id, name, state, content_type, size, digest}] | sort_by(.name)')
refresh_exact_release_assets "Pre-publish release reconciliation"
PUBLISH_RELEASE=$CURRENT_RELEASE
PUBLISH_ASSETS=$CURRENT_ASSETS
PUBLISH_STATE=$(jq -n --argjson release "$PUBLISH_RELEASE" --argjson assets "$PUBLISH_ASSETS" \
  '{release: $release, assets: $assets}')
FINAL_ACTION=$(printf '%s' "$PUBLISH_STATE" | release_state | jq -r '.action')
PUBLISH_ASSET_IDENTITY=$(printf '%s' "$PUBLISH_ASSETS" | jq -cS \
  '[.[] | {id, name, state, content_type, size, digest}] | sort_by(.name)')
if [ "$PUBLISH_ASSET_IDENTITY" != "$FINAL_ASSET_IDENTITY" ]; then
  echo "::error::Release asset identity changed before the publication write"
  exit 1
fi
if [ "$FINAL_ACTION" = "publish_draft" ]; then
  PUBLISH_FIELDS=(-F draft=false -F "prerelease=$EXPECTED_PRERELEASE")
  if [ "$MCPB_RELEASE_CHANNEL" = "latest" ]; then
    PUBLISH_FIELDS+=(-f make_latest=true)
  else
    PUBLISH_FIELDS+=(-f make_latest=false)
  fi
  require_job_reserve 2400 "GitHub Release publication"
  assert_remote_tag_identity
  if ! refresh_exact_release_assets "Immediate pre-publication reconciliation"; then
    echo "::error::Immediate pre-publication release snapshot is not authoritative"
    exit 1
  fi
  IMMEDIATE_PUBLISH_STATE=$(jq -n --argjson release "$CURRENT_RELEASE" \
    --argjson assets "$CURRENT_ASSETS" '{release: $release, assets: $assets}')
  FINAL_ACTION=$(printf '%s' "$IMMEDIATE_PUBLISH_STATE" | release_state | jq -r '.action')
  IMMEDIATE_ASSET_IDENTITY=$(printf '%s' "$CURRENT_ASSETS" | jq -cS \
    '[.[] | {id, name, state, content_type, size, digest}] | sort_by(.name)')
  if [ "$IMMEDIATE_ASSET_IDENTITY" != "$FINAL_ASSET_IDENTITY" ]; then
    echo "::error::Release asset identity changed at the immediate publication boundary"
    exit 1
  fi
  if [ "$FINAL_ACTION" = "publish_draft" ]; then
    if ! confirm_exact_draft_identity "Immediate pre-publication draft confirmation"; then
      exit 1
    fi
    CONFIRM_PUBLISH_STATE=$(jq -n --argjson release "$CONFIRM_RELEASE" \
      --argjson assets "$CONFIRM_ASSETS" '{release: $release, assets: $assets}')
    CONFIRM_PUBLISH_ACTION=$(printf '%s' "$CONFIRM_PUBLISH_STATE" | release_state | jq -r '.action')
    CONFIRM_ASSET_IDENTITY=$(printf '%s' "$CONFIRM_ASSETS" | jq -cS \
      '[.[] | {id, name, state, content_type, size, digest}] | sort_by(.name)')
    if [ "$CONFIRM_PUBLISH_ACTION" != "publish_draft" ] || \
       [ "$CONFIRM_ASSET_IDENTITY" != "$FINAL_ASSET_IDENTITY" ]; then
      echo "::error::Final pre-publication snapshot changed before the publication boundary"
      exit 1
    fi
    # The stable-channel guard is deliberately after reserve, tag
    # proof, and exact-ID refresh so it is the last remote read before
    # the one allowed publication PATCH.
    if [ "$MCPB_RELEASE_CHANNEL" = "latest" ]; then
      CURRENT_LATEST_VERSION="-"
      if github_latest_read; then
        CURRENT_LATEST_TAG=$(printf '%s' "$GITHUB_LATEST_SNAPSHOT" | /usr/bin/jq -er '.tag_name')
        CURRENT_LATEST_VERSION=${CURRENT_LATEST_TAG#v}
      else
        GITHUB_LATEST_EXIT=$?
        if [ "$GITHUB_LATEST_EXIT" -ne 4 ]; then
          echo "::error::GitHub latest-release lookup failed without an authoritative not-found response"
          exit 1
        fi
      fi
      node scripts/check-release-integrity.mjs channel-advance \
        "$VERSION" "$CURRENT_LATEST_VERSION" "$MCPB_RELEASE_CHANNEL"
    fi
    PATCH_EXIT=0
    PUBLISHED_RELEASE=""
    set +e
    PUBLISHED_RELEASE=$("$TIMEOUT_BIN" --kill-after=10s 120s "$GH_BIN" api --method PATCH \
      "repos/$MCPB_RELEASE_REPOSITORY/releases/$RELEASE_ID" "${PUBLISH_FIELDS[@]}")
    PATCH_EXIT=$?
    set -e
    if [ "$PATCH_EXIT" -eq 0 ]; then
      if PUBLISHED_SUMMARY=$(printf '%s' "$PUBLISHED_RELEASE" | jq -ce \
        'select(type == "object") | {
          id: (.id | select(type == "number" and . > 0 and floor == . and . <= 9007199254740991) | tostring),
          tag_name: (.tag_name | select(type == "string" and length > 0)),
          prerelease: (.prerelease | select(type == "boolean") | tostring),
          draft: (.draft | select(type == "boolean") | tostring)
        }'); then
        PUBLISHED_ID=$(printf '%s' "$PUBLISHED_SUMMARY" | jq -r '.id')
        PUBLISHED_TAG=$(printf '%s' "$PUBLISHED_SUMMARY" | jq -r '.tag_name')
        PUBLISHED_PRERELEASE=$(printf '%s' "$PUBLISHED_SUMMARY" | jq -r '.prerelease')
        if [ "$PUBLISHED_ID" != "$RELEASE_ID" ] || [ "$PUBLISHED_TAG" != "$TAG" ] || \
           [ "$PUBLISHED_PRERELEASE" != "$EXPECTED_PRERELEASE" ]; then
          echo "::error::Publish response contradicts the exact release identity; manual recovery required"
          exit 1
        fi
      else
        echo "::warning::Publish response was malformed; requiring exact-ID convergence without repeating PATCH"
      fi
    else
      echo "::warning::Publish PATCH exited $PATCH_EXIT; requiring exact-ID convergence without repeating PATCH"
    fi
  elif [ "$FINAL_ACTION" = "reuse_published" ]; then
    assert_remote_tag_identity
    echo "Recovered an externally completed exact publication before repeating PATCH"
  else
    echo "::error::Immediate six-asset state is not safe for publication or reuse"
    exit 1
  fi
elif [ "$FINAL_ACTION" = "reuse_published" ]; then
  assert_remote_tag_identity
else
  echo "::error::Exact six-asset set produced unexpected release action $FINAL_ACTION"
  exit 1
fi
for (( publish_attempt=1; publish_attempt<=12; publish_attempt++ )); do
  if ! EXACT_RELEASE=$(gh_read api "repos/$MCPB_RELEASE_REPOSITORY/releases/$RELEASE_ID"); then
    if [ "$publish_attempt" -eq 12 ]; then
      echo "::error::Exact release endpoint remained unreadable after 12 bounded checks"
      exit 1
    fi
    sleep 5
    continue
  fi
  if ! EXACT_ID=$(printf '%s' "$EXACT_RELEASE" | jq -er \
    '.id | select(type == "number" and . > 0 and floor == . and . <= 9007199254740991) | tostring') || \
     ! EXACT_TAG=$(printf '%s' "$EXACT_RELEASE" | jq -er \
       '.tag_name | select(type == "string" and length > 0)') || \
     ! EXACT_PRERELEASE=$(printf '%s' "$EXACT_RELEASE" | jq -er \
       '.prerelease | select(type == "boolean") | tostring') || \
     ! EXACT_DRAFT=$(printf '%s' "$EXACT_RELEASE" | jq -er \
       '.draft | select(type == "boolean") | tostring'); then
    if [ "$publish_attempt" -eq 12 ]; then
      echo "::error::Exact release endpoint remained malformed after 12 bounded checks"
      exit 1
    fi
    sleep 5
    continue
  fi
  if [ "$EXACT_ID" != "$RELEASE_ID" ] || [ "$EXACT_TAG" != "$TAG" ] || \
     [ "$EXACT_PRERELEASE" != "$EXPECTED_PRERELEASE" ]; then
    echo "::error::Exact release endpoint returned a divergent publish identity"
    exit 1
  fi
  if [ "$EXACT_DRAFT" = "false" ]; then break; fi
  if [ "$EXACT_DRAFT" != "true" ] || [ "$publish_attempt" -eq 12 ]; then
    echo "::error::Exact release endpoint did not converge to draft=false"
    exit 1
  fi
  sleep 5
done
for (( published_list_attempt=1; published_list_attempt<=12; published_list_attempt++ )); do
  if ! RELEASE_PAGES=$(gh_read api --paginate --slurp \
    "repos/$MCPB_RELEASE_REPOSITORY/releases?per_page=100"); then
    if [ "$published_list_attempt" -eq 12 ]; then
      echo "::error::Published release list remained unreadable after 12 bounded checks"
      exit 1
    fi
    sleep 5
    continue
  fi
  RELEASES=$(printf '%s' "$RELEASE_PAGES" | node scripts/check-release-integrity.mjs \
    flatten-pages release)
  RELEASE_COUNT=$(printf '%s' "$RELEASES" | jq --arg tag "$TAG" \
    '[.[] | select(.tag_name == $tag)] | length')
  if [ "$RELEASE_COUNT" -gt 1 ]; then
    echo "::error::Published release list contains duplicate releases for $TAG"
    exit 1
  fi
  if [ "$RELEASE_COUNT" -eq 1 ]; then
    RELEASE_JSON=$(printf '%s' "$RELEASES" | jq --arg tag "$TAG" \
      '.[] | select(.tag_name == $tag)')
    LISTED_ID=$(printf '%s' "$RELEASE_JSON" | jq -er \
      '.id | select(type == "number" and . > 0 and floor == . and . <= 9007199254740991) | tostring')
    LISTED_PRERELEASE=$(printf '%s' "$RELEASE_JSON" | jq -er \
      '.prerelease | select(type == "boolean") | tostring')
    LISTED_DRAFT=$(printf '%s' "$RELEASE_JSON" | jq -er \
      '.draft | select(type == "boolean") | tostring')
    if [ "$LISTED_ID" != "$RELEASE_ID" ] || [ "$LISTED_PRERELEASE" != "$EXPECTED_PRERELEASE" ]; then
      echo "::error::Published release list returned a divergent exact-tag identity"
      exit 1
    fi
    if [ "$LISTED_DRAFT" = "false" ]; then break; fi
  fi
  if [ "$published_list_attempt" -eq 12 ]; then
    echo "::error::Published release list did not converge to one exact non-draft release"
    exit 1
  fi
  sleep 5
done
for (( post_publish_asset_attempt=1; post_publish_asset_attempt<=12; post_publish_asset_attempt++ )); do
  if ! POST_ASSET_PAGES=$(gh_read api --paginate --slurp \
    "repos/$MCPB_RELEASE_REPOSITORY/releases/$RELEASE_ID/assets?per_page=100"); then
    if [ "$post_publish_asset_attempt" -eq 12 ]; then
      echo "::error::Published asset collection remained unreadable after 12 bounded checks"
      exit 1
    fi
    sleep 5
    continue
  fi
  POST_ASSETS=$(printf '%s' "$POST_ASSET_PAGES" | node scripts/check-release-integrity.mjs \
    flatten-pages asset)
  POST_ASSET_COUNT=$(printf '%s' "$POST_ASSETS" | jq 'length')
  if [ "$POST_ASSET_COUNT" -lt 6 ]; then
    PENDING_RELEASE=$(printf '%s' "$EXACT_RELEASE" | jq -c '.draft = true')
    PENDING_STATE=$(jq -n --argjson release "$PENDING_RELEASE" --argjson assets "$POST_ASSETS" \
      '{release: $release, assets: $assets}')
    printf '%s' "$PENDING_STATE" | release_state >/dev/null
  fi
  POST_ASSET_VISIBILITY=$(node scripts/check-release-integrity.mjs visibility \
    "$POST_ASSET_COUNT" 6 "$post_publish_asset_attempt" 12 "published release $TAG asset set" | \
    jq -r '.action')
  if [ "$POST_ASSET_VISIBILITY" = "retry" ]; then
    sleep 5
    continue
  fi
  POST_STATE=$(jq -n --argjson release "$EXACT_RELEASE" --argjson assets "$POST_ASSETS" \
    '{release: $release, assets: $assets}')
  POST_ACTION=$(printf '%s' "$POST_STATE" | release_state | jq -r '.action')
  if [ "$POST_ACTION" != "reuse_published" ]; then
    echo "::error::Published release did not retain one complete uploaded asset set"
    exit 1
  fi
  POST_ASSET_IDENTITY=$(printf '%s' "$POST_ASSETS" | jq -cS \
    '[.[] | {id, name, state, content_type, size, digest}] | sort_by(.name)')
  if [ "$POST_ASSET_IDENTITY" != "$FINAL_ASSET_IDENTITY" ]; then
    echo "::error::Published release asset identity changed across the publication boundary"
    exit 1
  fi
  break
done
if [ "$MCPB_RELEASE_CHANNEL" = "latest" ]; then
  for (( latest_attempt=1; latest_attempt<=12; latest_attempt++ )); do
    if ! LATEST_RELEASE=$(gh_read api "repos/$MCPB_RELEASE_REPOSITORY/releases/latest"); then
      if [ "$latest_attempt" -eq 12 ]; then
        echo "::error::GitHub latest endpoint remained unreadable after 12 bounded checks"
        exit 1
      fi
      sleep 5
      continue
    fi
    if ! LATEST_TAG=$(printf '%s' "$LATEST_RELEASE" | jq -er \
      '.tag_name | select(type == "string" and length > 0)') || \
       ! LATEST_ID=$(printf '%s' "$LATEST_RELEASE" | jq -er \
         '.id | select(type == "number" and . > 0 and floor == . and . <= 9007199254740991) | tostring'); then
      if [ "$latest_attempt" -eq 12 ]; then
        echo "::error::GitHub latest endpoint remained malformed after 12 bounded checks"
        exit 1
      fi
      sleep 5
      continue
    fi
    if [ "$LATEST_TAG" = "$TAG" ] && [ "$LATEST_ID" = "$RELEASE_ID" ]; then break; fi
    if [ "$LATEST_TAG" = "$TAG" ] && [ "$LATEST_ID" != "$RELEASE_ID" ]; then
      echo "::error::GitHub latest returned the expected tag with a divergent release ID"
      exit 1
    fi
    if [ "$latest_attempt" -eq 12 ]; then
      echo "::error::Published stable release $TAG did not become GitHub's latest release"
      exit 1
    fi
    sleep 5
  done
fi
assert_remote_tag_identity
