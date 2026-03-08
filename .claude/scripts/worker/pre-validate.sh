#!/usr/bin/env bash
# pre-validate.sh — Run before merge requests to catch issues.
# Override with project-specific validation (tsc, tests, lint).
set -euo pipefail
echo "[pre-validate] Running basic checks..."

# TypeScript check (if tsconfig exists)
if [ -f "tsconfig.json" ]; then
  echo "  TypeScript..."
  npx tsc --noEmit || { echo "TypeScript errors found"; exit 1; }
fi

# Test (if test script exists)
if grep -q '"test"' package.json 2>/dev/null; then
  echo "  Tests..."
  npm test || { echo "Tests failed"; exit 1; }
fi

echo "[pre-validate] All checks passed"
