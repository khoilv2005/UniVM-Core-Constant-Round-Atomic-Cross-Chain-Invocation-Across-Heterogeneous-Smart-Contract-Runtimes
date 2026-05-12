package succinct

import (
	"fmt"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

var (
	bytes32Ty = mustType("bytes32")
	uint64Ty  = mustType("uint64")
	bytesTy   = mustType("bytes")

	publicValueArgs = abi.Arguments{
		{Type: bytes32Ty},
		{Type: bytes32Ty},
		{Type: bytes32Ty},
		{Type: bytes32Ty},
		{Type: bytes32Ty},
		{Type: uint64Ty},
		{Type: uint64Ty},
		{Type: bytes32Ty},
	}
	proofEnvelopeArgs = abi.Arguments{
		{Type: bytesTy},
		{Type: bytesTy},
	}
)

var PublicValuesDomain = crypto.Keccak256Hash([]byte("XSMART_SUCCINCT_STATE_IMPORT_V1"))

type StateImportBinding struct {
	ChainID          common.Hash
	ContractID       common.Hash
	SchemaHash       common.Hash
	OpID             common.Hash
	LockEpoch        uint64
	StateVersion     uint64
	EncodedStateHash common.Hash
}

func BuildPublicValues(binding StateImportBinding) ([]byte, error) {
	return publicValueArgs.Pack(
		PublicValuesDomain,
		binding.ChainID,
		binding.ContractID,
		binding.SchemaHash,
		binding.OpID,
		binding.LockEpoch,
		binding.StateVersion,
		binding.EncodedStateHash,
	)
}

func BuildProofEnvelope(binding StateImportBinding, proofBytes []byte) ([]byte, []byte, error) {
	if len(proofBytes) == 0 {
		return nil, nil, fmt.Errorf("succinct proof bytes are required")
	}
	publicValues, err := BuildPublicValues(binding)
	if err != nil {
		return nil, nil, err
	}
	envelope, err := proofEnvelopeArgs.Pack(publicValues, proofBytes)
	if err != nil {
		return nil, nil, err
	}
	return envelope, publicValues, nil
}

func mustType(name string) abi.Type {
	ty, err := abi.NewType(name, "", nil)
	if err != nil {
		panic(err)
	}
	return ty
}
