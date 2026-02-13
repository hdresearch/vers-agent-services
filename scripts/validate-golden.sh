#!/bin/bash
# Usage: ./validate-golden.sh <vm-id>
# Checks a VM for all required tools and configs before committing as golden image

VM_ID=$1
if [ -z "$VM_ID" ]; then echo "Usage: $0 <vm-id>"; exit 1; fi

HOST="root@${VM_ID}.vm.vers.sh"
FAIL=0

check() {
  local name=$1
  local cmd=$2
  echo -n "  $name... "
  if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 $HOST "$cmd" &>/dev/null; then
    echo "✅"
  else
    echo "❌"
    FAIL=1
  fi
}

echo "🔍 Validating golden image VM: $VM_ID"
echo ""
echo "Required tools:"
check "node" "which node"
check "npm" "which npm"
check "git" "which git"
check "gh" "which gh"
check "curl" "which curl"
check "jq" "which jq"
check "tmux" "which tmux"
check "pi" "which pi"

echo ""
echo "Pi configuration:"
check "settings.json exists" "test -f ~/.pi/agent/settings.json"
check "pi has tools" "pi --tools 2>/dev/null | head -1 | grep -q tool"

echo ""
echo "Git configuration:"
check "git credentials" "test -f ~/.git-credentials"
check "git user.name" "git config user.name"
check "git user.email" "git config user.email"

echo ""
echo "Environment:"
check "VERS_AGENT_SERVICES_URL set" "test -n \"\$VERS_AGENT_SERVICES_URL\""
check "VERS_AUTH_TOKEN set" "test -n \"\$VERS_AUTH_TOKEN\""
check "ANTHROPIC_API_KEY not set" "test -z \"\$ANTHROPIC_API_KEY\""  # Should NOT be baked in

echo ""
echo "No stale processes:"
check "no tmux sessions" "! tmux list-sessions 2>/dev/null | grep -q ."
check "no node processes" "! pgrep -x node"

echo ""
echo "Disk space:"
ssh -o StrictHostKeyChecking=no $HOST "df -h / | tail -1 | awk '{print \"  Used: \" \$3 \" / \" \$2 \" (\" \$5 \")\"}'"

echo ""
if [ $FAIL -eq 0 ]; then
  echo "✅ All checks passed — safe to commit as golden image"
else
  echo "❌ Some checks failed — fix before committing"
  exit 1
fi
