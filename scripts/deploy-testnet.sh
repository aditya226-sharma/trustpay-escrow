#!/usr/bin/env bash
# Deploy TrustPay contracts to the Stellar testnet.
# Requires: stellar CLI 27.x, a funded "deployer" account configured.
# Usage: ./scripts/deploy-testnet.sh [--wasm-dir PATH]
set -euo pipefail

NETWORK="${STELLAR_NETWORK:-testnet}"
SOURCE="${DEPLOYER_ACCOUNT:-deployer}"
WASM_DIR="${1:-$(pwd)/target/wasm32v1-none/release}"

deploy_contract() {
  local name="$1"
  local wasm="$WASM_DIR/${name}.wasm"
  if [[ ! -f "$wasm" ]]; then
    echo "ERROR: $wasm not found. Build first:" >&2
    echo "  cargo build --release --target wasm32v1-none" >&2
    exit 1
  fi
  local hash
  hash=$(stellar contract install --network "$NETWORK" --source "$SOURCE" --wasm "$wasm")
  echo "installed ${name}: ${hash}"
  local id
  id=$(stellar contract deploy --network "$NETWORK" --source "$SOURCE" --wasm-hash "$hash")
  echo "deployed ${name}: ${id}"
  echo "${name}=${id}"
}

echo "Deploying TrustPay contracts to ${NETWORK}..."
deploy_contract trustpay_arbitrator
deploy_contract trustpay_escrow
echo "Done. Save the printed IDs and run initialize with your admin address:"
echo "  stellar contract invoke --network testnet --source ${SOURCE} --id <ESCROW_ID> -- initialize --admin <ADMIN_ADDRESS>"
