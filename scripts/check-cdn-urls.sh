#!/bin/bash
# Verify all CDN URLs in HTML files are reachable
# Usage: ./scripts/check-cdn-urls.sh

set -e

echo "Checking CDN URLs in HTML files..."

# Extract all URLs from href and src attributes
urls=$(grep -roh 'https://[^"'"'"' ]*\.\(js\|css\)' e2e/ docs/ 2>/dev/null | sort -u)

if [ -z "$urls" ]; then
  echo "No CDN URLs found."
  exit 0
fi

failed=0
for url in $urls; do
  status=$(curl -s -o /dev/null -w "%{http_code}" "$url" --max-time 5 2>/dev/null || echo "000")
  if [ "$status" = "200" ]; then
    echo "  ✓ $url"
  else
    echo "  ✗ $url (HTTP $status)"
    failed=1
  fi
done

if [ "$failed" -eq 1 ]; then
  echo ""
  echo "Some URLs are unreachable!"
  exit 1
fi

echo ""
echo "All URLs OK."
