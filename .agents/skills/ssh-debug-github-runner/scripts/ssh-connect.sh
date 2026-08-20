#!/usr/bin/env bash
# SSH into GitHub Actions runner after workflow posts tmate comment.
# Usage: ssh-connect.sh PR_NUMBER [RUN_ID]
# If no run ID, uses latest SSH comment.
set -euo pipefail

PR_NUMBER="${1:-}"
RUN_ID="${2:-}"
POLL_INTERVAL=5
TIMEOUT=90

# --- Get PR number ---
if [ -z "$PR_NUMBER" ]; then
  PR_NUMBER=$(gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number')
  if [ -z "$PR_NUMBER" ]; then
    echo "ERROR: No open PR found for current branch" >&2
    exit 1
  fi
fi
echo "PR #$PR_NUMBER"

# --- Wait for SSH comment ---
echo "Waiting for SSH comment (timeout ${TIMEOUT}s)..."
SSH_CMD=""
for i in $(seq 1 $((TIMEOUT / POLL_INTERVAL))); do
  if [ -n "$RUN_ID" ]; then
    # Find comment for specific run
    SSH_CMD=$(gh api "repos/{owner}/{repo}/issues/$PR_NUMBER/comments" \
      --jq ".[] | select(.body | contains(\"Run: $RUN_ID\")) | .body" 2>/dev/null |
      grep -oP 'ssh \K[^\s]+' || true)
  else
    # Find latest SSH comment (any run)
    SSH_CMD=$(gh api "repos/{owner}/{repo}/issues/$PR_NUMBER/comments" \
      --jq '.[] | select(.body | contains("SSH Debug Session")) | .body' 2>/dev/null |
      grep -oP 'ssh \K[^\s]+' || true)
  fi
  if [ -n "$SSH_CMD" ]; then
    break
  fi
  echo "  $((i * POLL_INTERVAL))s..."
  sleep "$POLL_INTERVAL"
done

if [ -z "$SSH_CMD" ]; then
  echo "ERROR: No SSH comment found after ${TIMEOUT}s" >&2
  exit 1
fi
echo "SSH command: ssh $SSH_CMD"

# --- Create Herdr pane ---
PANE_ID=$(herdr pane split --current --direction right --cwd "$PWD" --no-focus | jq -r '.result.pane.pane_id')
echo "Pane: $PANE_ID"

# --- Run SSH ---
herdr pane send-text "$PANE_ID" "ssh $SSH_CMD"
herdr pane send-keys "$PANE_ID" enter

# --- Accept host key if prompted ---
echo "Checking for host key prompt..."
if herdr pane wait-output "$PANE_ID" --regex 'fingerprint|are you sure|host key' --timeout 10000 --raw 2>/dev/null; then
  echo "Accepting host key..."
  herdr pane send-text "$PANE_ID" "yes"
  herdr pane send-keys "$PANE_ID" enter
fi

# --- Dismiss tmux status bar (always present in tmate) ---
echo "Waiting for tmate to render..."
herdr pane wait-output "$PANE_ID" --regex '\[?' --timeout 15000 --raw 2>/dev/null || true
sleep 1
echo "Dismissing tmux status bar..."
herdr pane send-keys "$PANE_ID" q
sleep 0.5

# --- Wait for shell prompt ---
echo "Waiting for shell prompt..."
if herdr pane wait-output "$PANE_ID" --regex '\$|#|>' --timeout 30000 --raw 2>/dev/null; then
  echo ""
  echo "✅ SSH connected! You can now run commands in the runner."
  echo "   Try: herdr pane send-text $PANE_ID \"whoami && hostname\""
  echo ""
  herdr pane read "$PANE_ID" --source visible --lines 20
  exit 0
fi

echo "WARNING: Could not confirm shell prompt. Check pane manually."
herdr pane read "$PANE_ID" --source visible --lines 30
