#!/bin/bash
# Generate Fabric crypto materials using cryptogen
# Run this ONCE on a machine with cryptogen installed

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR"

echo "[INFO] Generating crypto materials..."

# Check for cryptogen
if ! command -v cryptogen &> /dev/null; then
    echo "[ERROR] cryptogen not found. Install Fabric binaries first."
    exit 1
fi

# Generate crypto materials
cryptogen generate --config="$OUTPUT_DIR/crypto-config.yaml" --output="$OUTPUT_DIR/crypto-config"

echo "[INFO] Crypto materials generated in: $OUTPUT_DIR/crypto-config/"

# Copy crypto to each VM
VM1_IP="${VM1_IP:-localhost}"
VM2_IP="${VM2_IP:-localhost}"
VM3_IP="${VM3_IP:-localhost}"
VM4_IP="${VM4_IP:-localhost}"

echo "[INFO] Crypto materials ready for distribution to VMs"
echo "[INFO] Copy crypto-config to each VM:"
echo "  VM1: scp -r crypto-config root@$VM1_IP:/data/fabric/"
echo "  VM2: scp -r crypto-config root@$VM2_IP:/data/fabric/"
echo "  VM3: scp -r crypto-config root@$VM3_IP:/data/fabric/"
echo "  VM4: scp -r crypto-config root@$VM4_IP:/data/fabric/"
