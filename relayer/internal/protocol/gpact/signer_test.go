package gpact

import (
	"crypto/ecdsa"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
)

func TestSignRootEventProducesRecoverableEthereumSignature(t *testing.T) {
	key, err := crypto.HexToECDSA("b71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291")
	if err != nil {
		t.Fatalf("HexToECDSA: %v", err)
	}

	var txID [32]byte
	txID[31] = 1
	var callTreeHash [32]byte
	callTreeHash[31] = 2

	sigs, err := SignRootEvent([]*ecdsa.PrivateKey{key}, txID, 1, callTreeHash, true, false)
	if err != nil {
		t.Fatalf("SignRootEvent: %v", err)
	}
	if len(sigs) != 1 {
		t.Fatalf("expected 1 signature, got %d", len(sigs))
	}
	if len(sigs[0]) != 65 {
		t.Fatalf("expected 65-byte signature, got %d", len(sigs[0]))
	}
	if sigs[0][64] != 27 && sigs[0][64] != 28 {
		t.Fatalf("unexpected recovery id %d", sigs[0][64])
	}

	packed, err := hashRootABI.Pack(rootEventTag, txID, big.NewInt(1), callTreeHash, true, false)
	if err != nil {
		t.Fatalf("Pack: %v", err)
	}
	digest := crypto.Keccak256Hash(packed)
	ethSigned := crypto.Keccak256Hash([]byte("\x19Ethereum Signed Message:\n32"), digest.Bytes())

	sig := append([]byte(nil), sigs[0]...)
	sig[64] -= 27
	pub, err := crypto.SigToPub(ethSigned.Bytes(), sig)
	if err != nil {
		t.Fatalf("SigToPub: %v", err)
	}
	got := crypto.PubkeyToAddress(*pub)
	want := crypto.PubkeyToAddress(key.PublicKey)
	if got != want {
		t.Fatalf("recovered address mismatch: got %s want %s", got.Hex(), want.Hex())
	}
}
