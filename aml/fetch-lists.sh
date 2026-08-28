#!/usr/bin/env bash
# 제재 명단 원본 3종을 받는다. 원본은 커밋하지 않는다 — 매일 바뀌고 57MB다.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/raw
echo "OFAC SDN …";  curl -sL --max-time 180 -o data/raw/ofac_sdn.xml        "https://www.treasury.gov/ofac/downloads/sdn.xml"
echo "UN …";        curl -sL --max-time 120 -o data/raw/un_consolidated.xml "https://scsanctions.un.org/resources/xml/en/consolidated.xml"
echo "EU FSF …";    curl -sL --max-time 120 -o data/raw/eu_fsf.xml          "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw"
ls -lh data/raw/
echo "→ npx tsx aml/eval.ts 로 검증"
