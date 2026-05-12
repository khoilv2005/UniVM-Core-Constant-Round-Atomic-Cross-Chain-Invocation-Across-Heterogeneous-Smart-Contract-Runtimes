#!/bin/bash
# Download and setup Fabric binaries and config
# Run this script on each VM before starting Fabric containers

FABRIC_VERSION=2.5.4
FABRIC_CA_VERSION=1.5.5

echo "[INFO] Downloading Fabric binaries..."

# Create fabric directory
mkdir -p /opt/fabric/bin /opt/fabric/config

# Download fabric binaries
curl -sSL https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/bootstrap.sh | bash -s -- -s -d

# Move binaries
mv bin/* /opt/fabric/bin/ 2>/dev/null || true
mv config/* /opt/fabric/config/ 2>/dev/null || true

echo "[INFO] Fabric binaries installed to /opt/fabric/bin/"
echo "[INFO] Config installed to /opt/fabric/config/"

# Verify
ls -la /opt/fabric/bin/
