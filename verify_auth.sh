#!/usr/bin/env bash

# ==============================================================================
# verify_auth.sh - Automated Verification Test Script for Auth & RBAC
# Tests:
#   1. Candidate Registration (CANDIDATE role)
#   2. Admin Registration (ADMIN role)
#   3. Candidate & Admin Login (JWT token extraction)
#   4. GET /api/test/me with valid token (Expect 200 OK)
#   5. GET /api/test/admin-only as Candidate (Expect 403 Forbidden)
#   6. GET /api/test/admin-only as Admin (Expect 200 OK)
#   7. GET /api/test/me with no token (Expect 401 Unauthorized)
# ==============================================================================

BASE_URL="${BASE_URL:-http://localhost:5000}"
TIMESTAMP=$(date +%s)
CANDIDATE_EMAIL="candidate_${TIMESTAMP}@example.com"
ADMIN_EMAIL="admin_${TIMESTAMP}@example.com"
PASSWORD="SecurePassword123!"

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

PASSED_TESTS=0
FAILED_TESTS=0

echo -e "${BLUE}======================================================${NC}"
echo -e "${BLUE}   InterviewAI Backend - Auth & RBAC Verification     ${NC}"
echo -e "${BLUE}======================================================${NC}"
echo -e "Target URL: ${BASE_URL}"
echo -e "Candidate : ${CANDIDATE_EMAIL}"
echo -e "Admin     : ${ADMIN_EMAIL}"
echo ""

# Helper to extract JSON fields without hard dependency on jq
extract_json_field() {
  local json="$1"
  local field="$2"
  if command -v jq >/dev/null 2>&1; then
    echo "$json" | jq -r ".${field} // .data.${field} // empty"
  elif command -v python3 >/dev/null 2>&1; then
    echo "$json" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('$field') or (data.get('data', {}) if isinstance(data.get('data'), dict) else {}).get('$field') or '')"
  elif command -v python >/dev/null 2>&1; then
    echo "$json" | python -c "import sys, json; data=json.load(sys.stdin); print(data.get('$field') or (data.get('data', {}) if isinstance(data.get('data'), dict) else {}).get('$field') or '')"
  else
    # Grep/sed fallback
    echo "$json" | grep -o "\"$field\":[^,}]*" | head -n 1 | sed -e 's/"[^"]*"://' -e 's/^[ "]*//' -e 's/[ "]*$//'
  fi
}

assert_status() {
  local test_name="$1"
  local expected="$2"
  local actual="$3"
  local response_body="$4"

  if [ "$actual" -eq "$expected" ]; then
    echo -e "  [${GREEN}PASS${NC}] $test_name (HTTP $actual)"
    PASSED_TESTS=$((PASSED_TESTS + 1))
  else
    echo -e "  [${RED}FAIL${NC}] $test_name (Expected HTTP $expected, got HTTP $actual)"
    echo -e "         Response: $response_body"
    FAILED_TESTS=$((FAILED_TESTS + 1))
  fi
}

# ------------------------------------------------------------------------------
# Test 1: Register Candidate
# ------------------------------------------------------------------------------
echo -e "${YELLOW}Step 1: Registering Candidate User (CANDIDATE)...${NC}"
CANDIDATE_REG_RES=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{
    \"fullName\": \"Candidate Tester\",
    \"email\": \"${CANDIDATE_EMAIL}\",
    \"password\": \"${PASSWORD}\",
    \"role\": \"CANDIDATE\"
  }")

CANDIDATE_REG_BODY=$(echo "$CANDIDATE_REG_RES" | sed '$d')
CANDIDATE_REG_CODE=$(echo "$CANDIDATE_REG_RES" | tail -n 1)
assert_status "Register Candidate" 201 "$CANDIDATE_REG_CODE" "$CANDIDATE_REG_BODY"

# ------------------------------------------------------------------------------
# Test 2: Register Admin
# ------------------------------------------------------------------------------
echo -e "\n${YELLOW}Step 2: Registering Admin User (ADMIN)...${NC}"
ADMIN_REG_RES=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{
    \"fullName\": \"Admin Tester\",
    \"email\": \"${ADMIN_EMAIL}\",
    \"password\": \"${PASSWORD}\",
    \"role\": \"ADMIN\"
  }")

ADMIN_REG_BODY=$(echo "$ADMIN_REG_RES" | sed '$d')
ADMIN_REG_CODE=$(echo "$ADMIN_REG_RES" | tail -n 1)
assert_status "Register Admin" 201 "$ADMIN_REG_CODE" "$ADMIN_REG_BODY"

# ------------------------------------------------------------------------------
# Test 3: Login Candidate & Extract Token
# ------------------------------------------------------------------------------
echo -e "\n${YELLOW}Step 3: Logging in Candidate...${NC}"
CANDIDATE_LOGIN_RES=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"${CANDIDATE_EMAIL}\",
    \"password\": \"${PASSWORD}\"
  }")

CANDIDATE_LOGIN_BODY=$(echo "$CANDIDATE_LOGIN_RES" | sed '$d')
CANDIDATE_LOGIN_CODE=$(echo "$CANDIDATE_LOGIN_RES" | tail -n 1)
assert_status "Login Candidate" 200 "$CANDIDATE_LOGIN_CODE" "$CANDIDATE_LOGIN_BODY"

CANDIDATE_TOKEN=$(extract_json_field "$CANDIDATE_LOGIN_BODY" "token")
if [ -z "$CANDIDATE_TOKEN" ]; then
  echo -e "  [${RED}ERROR${NC}] Could not extract candidate JWT token."
fi

# ------------------------------------------------------------------------------
# Test 4: Login Admin & Extract Token
# ------------------------------------------------------------------------------
echo -e "\n${YELLOW}Step 4: Logging in Admin...${NC}"
ADMIN_LOGIN_RES=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"${ADMIN_EMAIL}\",
    \"password\": \"${PASSWORD}\"
  }")

ADMIN_LOGIN_BODY=$(echo "$ADMIN_LOGIN_RES" | sed '$d')
ADMIN_LOGIN_CODE=$(echo "$ADMIN_LOGIN_RES" | tail -n 1)
assert_status "Login Admin" 200 "$ADMIN_LOGIN_CODE" "$ADMIN_LOGIN_BODY"

ADMIN_TOKEN=$(extract_json_field "$ADMIN_LOGIN_BODY" "token")
if [ -z "$ADMIN_TOKEN" ]; then
  echo -e "  [${RED}ERROR${NC}] Could not extract admin JWT token."
fi

# ------------------------------------------------------------------------------
# Test 5: GET /api/test/me with Candidate Token (Expect 200)
# ------------------------------------------------------------------------------
echo -e "\n${YELLOW}Step 5: Testing GET /api/test/me with Candidate Token (Expect 200)...${NC}"
CANDIDATE_ME_RES=$(curl -s -w "\n%{http_code}" -X GET "${BASE_URL}/api/test/me" \
  -H "Authorization: Bearer ${CANDIDATE_TOKEN}")

CANDIDATE_ME_BODY=$(echo "$CANDIDATE_ME_RES" | sed '$d')
CANDIDATE_ME_CODE=$(echo "$CANDIDATE_ME_RES" | tail -n 1)
assert_status "Access /api/test/me as Candidate" 200 "$CANDIDATE_ME_CODE" "$CANDIDATE_ME_BODY"

# ------------------------------------------------------------------------------
# Test 6: GET /api/test/admin-only with Candidate Token (Expect 403 Forbidden)
# ------------------------------------------------------------------------------
echo -e "\n${YELLOW}Step 6: Testing GET /api/test/admin-only with Candidate Token (Expect 403 Forbidden)...${NC}"
CANDIDATE_ADMIN_RES=$(curl -s -w "\n%{http_code}" -X GET "${BASE_URL}/api/test/admin-only" \
  -H "Authorization: Bearer ${CANDIDATE_TOKEN}")

CANDIDATE_ADMIN_BODY=$(echo "$CANDIDATE_ADMIN_RES" | sed '$d')
CANDIDATE_ADMIN_CODE=$(echo "$CANDIDATE_ADMIN_RES" | tail -n 1)
assert_status "Reject /api/test/admin-only for Candidate (RBAC)" 403 "$CANDIDATE_ADMIN_CODE" "$CANDIDATE_ADMIN_BODY"

# ------------------------------------------------------------------------------
# Test 7: GET /api/test/admin-only with Admin Token (Expect 200 OK)
# ------------------------------------------------------------------------------
echo -e "\n${YELLOW}Step 7: Testing GET /api/test/admin-only with Admin Token (Expect 200 OK)...${NC}"
ADMIN_ACCESS_RES=$(curl -s -w "\n%{http_code}" -X GET "${BASE_URL}/api/test/admin-only" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}")

ADMIN_ACCESS_BODY=$(echo "$ADMIN_ACCESS_RES" | sed '$d')
ADMIN_ACCESS_CODE=$(echo "$ADMIN_ACCESS_RES" | tail -n 1)
assert_status "Grant /api/test/admin-only for Admin (RBAC)" 200 "$ADMIN_ACCESS_CODE" "$ADMIN_ACCESS_BODY"

# ------------------------------------------------------------------------------
# Test 8: GET /api/test/me without Token (Expect 401 Unauthorized)
# ------------------------------------------------------------------------------
echo -e "\n${YELLOW}Step 8: Testing GET /api/test/me without Token (Expect 401 Unauthorized)...${NC}"
NO_AUTH_RES=$(curl -s -w "\n%{http_code}" -X GET "${BASE_URL}/api/test/me")

NO_AUTH_BODY=$(echo "$NO_AUTH_RES" | sed '$d')
NO_AUTH_CODE=$(echo "$NO_AUTH_RES" | tail -n 1)
assert_status "Reject /api/test/me without token" 401 "$NO_AUTH_CODE" "$NO_AUTH_BODY"

# ------------------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------------------
echo -e "\n${BLUE}======================================================${NC}"
echo -e "${BLUE}                   Test Summary                       ${NC}"
echo -e "${BLUE}======================================================${NC}"
echo -e "Total Passed: ${GREEN}${PASSED_TESTS}${NC}"
echo -e "Total Failed: ${RED}${FAILED_TESTS}${NC}"

if [ "$FAILED_TESTS" -eq 0 ]; then
  echo -e "\n${GREEN}✔ All Auth & RBAC verification tests passed successfully!${NC}"
  exit 0
else
  echo -e "\n${RED}✘ Some tests failed. Check server logs and responses above.${NC}"
  exit 1
fi
