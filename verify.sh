#!/bin/bash

DOMAIN="larimerchess.org"
WWW_DOMAIN="www.$DOMAIN"

# Official GitHub Pages IPv4 addresses
GH_IPS=(
  "185.199.108.153"
  "185.199.109.153"
  "185.199.110.153"
  "185.199.111.153"
)

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=============================================="
echo " Checking GitHub Pages DNS for: $DOMAIN"
echo "=============================================="

# Check if 'dig' is installed
if ! command -v dig &> /dev/null; then
    echo -e "${RED}[ERROR]${NC} 'dig' command not found. Please install dnsutils (e.g., sudo apt install dnsutils or brew install bind)."
    exit 1
fi

# 1. Check Apex A Records
echo -e "\n--- 1. Checking Apex A Records ($DOMAIN) ---"
RESOLVED_IPS=$(dig +short A "$DOMAIN")

if [ -z "$RESOLVED_IPS" ]; then
    echo -e "${RED}[FAIL]${NC} No A records found for $DOMAIN."
else
    echo "Found the following IP addresses:"
    echo "$RESOLVED_IPS" | while read -r ip; do
        if [[ " ${GH_IPS[*]} " =~ " ${ip} " ]]; then
            echo -e "  - $ip: ${GREEN}[CORRECT]${NC} Matches GitHub Pages server."
        else
            echo -e "  - $ip: ${RED}[INCORRECT]${NC} Does not match GitHub Pages."
        fi
    done
fi

# 2. Check WWW Subdomain
echo -e "\n--- 2. Checking WWW Subdomain ($WWW_DOMAIN) ---"
WWW_CNAME=$(dig +short CNAME "$WWW_DOMAIN")
WWW_A=$(dig +short A "$WWW_DOMAIN")

if [ -n "$WWW_CNAME" ]; then
    echo -e "${GREEN}[PASS]${NC} Found CNAME for www: $WWW_CNAME"
elif [ -n "$WWW_A" ]; then
    echo -e "${YELLOW}[WARN]${NC} Found A records for www instead of a CNAME. (A records for www are okay, but CNAME is standard)."
else
    echo -e "${RED}[FAIL]${NC} $WWW_DOMAIN does not resolve to any CNAME or A records."
fi

# 3. HTTP / HTTPS Response Check
echo -e "\n--- 3. Checking HTTP Response Headers ---"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://$DOMAIN")
HTTPS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://$DOMAIN" --max-time 5)

echo -e "HTTP Status (http://$DOMAIN):   $HTTP_CODE"
echo -e "HTTPS Status (https://$DOMAIN): $HTTPS_CODE"

if [ "$HTTP_CODE" == "301" ] || [ "$HTTP_CODE" == "302" ] || [ "$HTTP_CODE" == "200" ]; then
    echo -e "${GREEN}[PASS]${NC} Domain is responding to web traffic."
else
    echo -e "${YELLOW}[INFO]${NC} If DNS was just changed, propagation can take up to 24 hours."
fi

echo "=============================================="
echo " Verification Complete."
echo "=============================================="
