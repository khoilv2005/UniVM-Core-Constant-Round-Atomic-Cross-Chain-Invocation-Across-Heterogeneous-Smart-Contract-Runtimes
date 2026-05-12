#!/bin/bash
# Create Fabric channel and join peers
# Run this after crypto materials are distributed

set -e

CHANNEL_NAME="mychannel"
CHANNEL_TX="$SCRIPT_DIR/channel-artifacts/channel.tx"
GENESIS_BLOCK="$SCRIPT_DIR/channel-artifacts/genesis.block"

echo "[INFO] Creating channel '$CHANNEL_NAME'..."

# Generate genesis block
configtxgen -profile ThreeOrgsOrdererGenesis \
    -outputBlock "$GENESIS_BLOCK" \
    -channelID sys-channel

# Generate channel transaction
configtxgen -profile ThreeOrgsChannel \
    -outputCreateChannelTx "$CHANNEL_TX" \
    -channelID "$CHANNEL_NAME"

echo "[INFO] Genesis block: $GENESIS_BLOCK"
echo "[INFO] Channel tx: $CHANNEL_TX"

# Create channel on Orderer1
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_TLS_ENABLED=false
export CORE_PEER_ADDRESS="peer1.org1.example.com:7051"
export ORDERER_CA=""

# Join peer1.org1 to channel
peer channel create \
    -f "$CHANNEL_TX" \
    -c "$CHANNEL_NAME" \
    -o orderer1.example.com:7050 \
    --outputBlock /tmp/"$CHANNEL_NAME".block

# Peer1 joins
peer channel join -b /tmp/"$CHANNEL_NAME".block

# Peer2 joins
export CORE_PEER_ADDRESS="peer2.org1.example.com:7051"
peer channel join -b /tmp/"$CHANNEL_NAME".block

# Org2 peers join
export CORE_PEER_LOCALMSPID="Org2MSP"
export CORE_PEER_ADDRESS="peer1.org2.example.com:7051"
peer channel join -b /tmp/"$CHANNEL_NAME".block

export CORE_PEER_ADDRESS="peer2.org2.example.com:7051"
peer channel join -b /tmp/"$CHANNEL_NAME".block

# Update anchor peers
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_ADDRESS="peer1.org1.example.com:7051"
peer channel update -f "$SCRIPT_DIR/channel-artifacts/Org1MSPanchors.tx" -c "$CHANNEL_NAME" -o orderer1.example.com:7050

export CORE_PEER_LOCALMSPID="Org2MSP"
export CORE_PEER_ADDRESS="peer1.org2.example.com:7051"
peer channel update -f "$SCRIPT_DIR/channel-artifacts/Org2MSPanchors.tx" -c "$CHANNEL_NAME" -o orderer1.example.com:7050

echo "[INFO] Channel created and peers joined!"
