#!/usr/bin/env bash
# Fetches the three source sanctions lists. We do not commit them: 57MB and they change daily.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/raw
tmp="$(mktemp -d /tmp/proofmark-lists.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

download() {
  curl --fail --silent --show-error --location \
    --connect-timeout 20 --max-time 180 \
    --retry 5 --retry-delay 5 --retry-max-time 600 --retry-all-errors \
    -o "$1" "$2"
}

echo "OFAC SDN …";  download "$tmp/ofac_sdn.xml"        "https://www.treasury.gov/ofac/downloads/sdn.xml"
echo "UN …";        download "$tmp/un_consolidated.xml" "https://scsanctions.un.org/resources/xml/en/consolidated.xml"
echo "EU FSF …";    download "$tmp/eu_fsf.xml"          "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw"

# Reject login pages, empty responses and truncated downloads before replacing a known-good list.
[ "$(wc -c < "$tmp/ofac_sdn.xml")" -gt 1000000 ] || { echo "OFAC response is too small" >&2; exit 1; }
[ "$(wc -c < "$tmp/un_consolidated.xml")" -gt 100000 ] || { echo "UN response is too small" >&2; exit 1; }
[ "$(wc -c < "$tmp/eu_fsf.xml")" -gt 1000000 ] || { echo "EU response is too small" >&2; exit 1; }
grep -q '<' "$tmp/ofac_sdn.xml" && grep -q '<' "$tmp/un_consolidated.xml" && grep -q '<' "$tmp/eu_fsf.xml" \
  || { echo "one or more list responses are not XML" >&2; exit 1; }

mv "$tmp/ofac_sdn.xml" data/raw/ofac_sdn.xml
mv "$tmp/un_consolidated.xml" data/raw/un_consolidated.xml
mv "$tmp/eu_fsf.xml" data/raw/eu_fsf.xml
ls -lh data/raw/
echo "-> build and verify with: npx tsx aml/build-index.ts && npx tsx aml/eval.ts"
