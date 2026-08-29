#!/usr/bin/env bash
# Fetches the three source sanctions lists. We do not commit them: 57MB and they change daily.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/raw
echo "OFAC SDN …";  curl -sL --max-time 180 -o data/raw/ofac_sdn.xml        "https://www.treasury.gov/ofac/downloads/sdn.xml"
echo "UN …";        curl -sL --max-time 120 -o data/raw/un_consolidated.xml "https://scsanctions.un.org/resources/xml/en/consolidated.xml"
echo "EU FSF …";    curl -sL --max-time 120 -o data/raw/eu_fsf.xml          "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw"
ls -lh data/raw/
echo "-> verify with: npx tsx aml/eval.ts"
