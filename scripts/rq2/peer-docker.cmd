@echo off
setlocal enabledelayedexpansion
set "ARGS="
:arg_loop
if "%~1"=="" goto run_peer
set "ARG=%~1"
set "ARG=!ARG:%cd%=/repo!"
set "ARG=!ARG:\=/!"
set "ARGS=!ARGS! "!ARG!""
shift
goto arg_loop

:run_peer
docker run --rm ^
  --add-host orderer1.example.com:209.38.21.129 ^
  --add-host peer0.org1.example.com:209.38.21.129 ^
  --add-host peer1.org1.example.com:170.64.194.4 ^
  --add-host peer0.org2.example.com:170.64.164.173 ^
  --add-host peer1.org2.example.com:134.199.160.48 ^
  -e CORE_PEER_LOCALMSPID=Org1MSP ^
  -e CORE_PEER_MSPCONFIGPATH=/repo/configs/fabric/crypto-generated/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp ^
  -e CORE_PEER_TLS_ENABLED=true ^
  -e CORE_PEER_TLS_ROOTCERT_FILE=/repo/configs/fabric/crypto-generated/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt ^
  -e CORE_PEER_ADDRESS=peer0.org1.example.com:7051 ^
  -v "%cd%:/repo" ^
  -w /repo ^
  hyperledger/fabric-tools:2.5 peer %ARGS%
