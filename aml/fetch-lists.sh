#!/usr/bin/env bash
# Validates a complete generation before atomically switching the local CLI pointer.
set -euo pipefail
cd "$(dirname "$0")/.."
exec npx tsx aml/fetch-lists.ts
