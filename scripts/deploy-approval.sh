#!/usr/bin/env bash
# Approval gate for one stage of deploy-sdf.yml. Opens an issue and waits until an allowlisted
# GitHub login comments `/approve <first 12 characters of the commit SHA>` or `/deny <reason>`,
# the same convention as the gateway's GitHub approval channel (ADR 0004).
#
# Why: environment required reviewers are not available for private repositories on personal
# GitHub plans, so the workflow cannot rely on them. If they are configured, they gate the job
# before this step runs, and this gate still applies.
#
# Env: GH_TOKEN (issues: write), GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SERVER_URL,
#      STAGE, SHA, MODE, APPROVERS (comma- or space-separated logins),
#      APPROVAL_TIMEOUT_MINUTES (default 60). Writes approver=<login> to GITHUB_OUTPUT.
set -euo pipefail

: "${STAGE:?}" "${SHA:?}" "${MODE:?}"
approvers=$(tr ',' ' ' <<<"${APPROVERS:-}" | tr '[:upper:]' '[:lower:]' | xargs)
if [ -z "$approvers" ]; then
  echo "::error::NS_DEPLOY_APPROVERS is empty: set it to the GitHub logins allowed to approve deploys (docs/release.md)."
  exit 1
fi
prefix=${SHA:0:12}
timeout=$(( ${APPROVAL_TIMEOUT_MINUTES:-60} * 60 ))
run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
subject=$(git log -1 --format=%s "$SHA" 2>/dev/null || echo "")

body=$(cat <<EOF
deploy-sdf wants to **${MODE}** commit \`${SHA}\` in stage **${STAGE}**.

- Commit: ${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/commit/${SHA} ${subject:+(${subject})}
- Run: ${run_url}
- Target: the demo account TSTDRV1755417 for both stages (owner decision 2026-10-22; a pipeline rehearsal, not a production deploy)

To approve, comment \`/approve ${prefix}\`. To deny, comment \`/deny <reason>\`. Only these logins count: ${approvers}.
The run waits up to $(( timeout / 60 )) minutes, then gives up.
EOF
)
issue_url=$(gh issue create --repo "$GITHUB_REPOSITORY" \
  --title "deploy-sdf: ${STAGE} ${MODE} of ${SHA:0:7} (run ${GITHUB_RUN_ID})" --body "$body")
issue=${issue_url##*/}
echo "Waiting for a decision on $issue_url"
echo "- ${STAGE}: approval issue ${issue_url}" >> "$GITHUB_STEP_SUMMARY"

close() {
  gh issue comment "$issue" --repo "$GITHUB_REPOSITORY" --body "$1" >/dev/null
  gh issue close "$issue" --repo "$GITHUB_REPOSITORY" >/dev/null
}
trap 'close "Run ended before a decision was recorded (${run_url})."' TERM INT

deadline=$(( $(date +%s) + timeout ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  # Oldest first; the first valid decision from an approver wins.
  while IFS=$'\t' read -r login text; do
    login=$(tr '[:upper:]' '[:lower:]' <<<"$login")
    [[ " $approvers " == *" $login "* ]] || continue
    if [[ "$text" =~ ^/approve[[:space:]]+([0-9a-fA-F]{12})([[:space:]]|$) ]] \
      && [ "$(tr '[:upper:]' '[:lower:]' <<<"${BASH_REMATCH[1]}")" = "$prefix" ]; then
      trap - TERM INT
      close "Approved by @${login}. ${STAGE} continues: ${run_url}"
      echo "approver=$login" >> "$GITHUB_OUTPUT"
      echo "- ${STAGE}: approved by @${login}" >> "$GITHUB_STEP_SUMMARY"
      echo "Approved by $login"
      exit 0
    fi
    if [[ "$text" =~ ^/deny ]]; then
      trap - TERM INT
      close "Denied by @${login}. ${STAGE} stops: ${run_url}"
      echo "- ${STAGE}: denied by @${login}" >> "$GITHUB_STEP_SUMMARY"
      echo "::error::Denied by $login: ${text:0:300}"
      exit 1
    fi
  done < <(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$issue/comments?per_page=100" \
    -q '.[] | [.user.login, (.body | split("\n")[0] | gsub("^\\s+|\\s+$"; ""))] | @tsv')
  sleep 20
done

trap - TERM INT
close "No decision within $(( timeout / 60 )) minutes. ${STAGE} stops: ${run_url}"
echo "::error::No approval within $(( timeout / 60 )) minutes."
exit 1
