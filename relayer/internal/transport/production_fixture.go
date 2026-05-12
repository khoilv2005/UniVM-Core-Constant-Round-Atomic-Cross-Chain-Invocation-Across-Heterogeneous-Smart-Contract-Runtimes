package transport

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"sync"
	"time"

	fabricproof "github.com/xsmart/relayer/internal/proof/fabric"
	substrateproof "github.com/xsmart/relayer/internal/proof/substrate"
)

var productionFixtureMu sync.Mutex

func buildSubstrateHostProductionFixture(chain string, chainID uint64, endpoint string, eventArgs map[string]any, block uint64) ([]byte, []byte, error) {
	productionFixtureMu.Lock()
	defer productionFixtureMu.Unlock()

	encodedState, err := json.Marshal(argsExcluding(eventArgs, "proof", "production_proof", "substrate_finality_proof", "verificationMode"))
	if err != nil {
		return nil, nil, err
	}
	stateHash := sha256.Sum256(encodedState)
	keys := make([]ed25519.PrivateKey, 4)
	authorities := make([]substrateproof.Authority, 4)
	for i := range keys {
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, nil, err
		}
		keys[i] = priv
		authorities[i] = substrateproof.Authority{
			ID:        fmt.Sprintf("fixture-%d", i),
			PublicKey: hex.EncodeToString(pub),
			Weight:    1,
		}
	}
	if block == 0 {
		block = 1
	}
	proof := substrateproof.FinalityProof{
		SetID:                1,
		Round:                1,
		FinalizedBlockNumber: block,
		FinalizedBlockHash:   fixedHashHex("substrate-block|" + chain + "|" + blockString(block)),
		StateRoot:            fixedHashHex("substrate-state|" + chain + "|" + blockString(block)),
		StorageProofHash:     fixedHashHex("substrate-storage|" + endpoint + "|" + blockString(block)),
		Authorities:          authorities,
		Binding: substrateproof.MetadataBinding{
			ChainID:          fmt.Sprintf("%s:%d", chain, chainID),
			ContractID:       endpoint,
			SchemaHash:       fixedHashHex("schema|" + chain + "|" + endpoint),
			OpID:             firstNonEmptyString(stringFromArgs(eventArgs, "crossChainTxId", "cross_chain_tx_id"), "0"),
			LockEpoch:        block,
			StateVersion:     block,
			StatePayloadHash: hex.EncodeToString(stateHash[:]),
			HashAlgorithm:    "sha256",
		},
	}
	payload, err := substrateproof.SigningPayload(proof)
	if err != nil {
		return nil, nil, err
	}
	for i := 0; i < 3; i++ {
		proof.Signatures = append(proof.Signatures, substrateproof.Signature{
			AuthorityID: authorities[i].ID,
			Signature:   hex.EncodeToString(ed25519.Sign(keys[i], payload)),
		})
	}
	raw, err := json.Marshal(proof)
	if err != nil {
		return nil, nil, err
	}
	return raw, encodedState, nil
}

func buildFabricHostProductionFixture(chain string, chainID uint64, endpoint string, eventArgs map[string]any, block uint64) ([]byte, error) {
	productionFixtureMu.Lock()
	defer productionFixtureMu.Unlock()

	now := time.Now().UTC()
	rootCert, rootKey, rootPEM, err := makeFixtureRootCA(now)
	if err != nil {
		return nil, err
	}
	org1Cert, org1Key, org1PEM, err := makeFixtureLeaf(rootCert, rootKey, "Org1MSP", now)
	if err != nil {
		return nil, err
	}
	org2Cert, org2Key, org2PEM, err := makeFixtureLeaf(rootCert, rootKey, "Org2MSP", now)
	if err != nil {
		return nil, err
	}
	_ = org1Cert
	_ = org2Cert
	if block == 0 {
		block = 1
	}
	encodedState, err := json.Marshal(argsExcluding(eventArgs, "proof", "production_proof", "fabric_msp_proof", "verificationMode"))
	if err != nil {
		return nil, err
	}
	proposalPayload := []byte("fabric-proposal|" + chain + "|" + endpoint + "|" + blockString(block))
	rwSet := []byte("fabric-rwset|" + chain + "|" + endpoint + "|" + blockString(block))
	payloadHash := sha256.Sum256(proposalPayload)
	rwHash := sha256.Sum256(rwSet)
	stateHash := sha256.Sum256(encodedState)
	evidence := fabricproof.Evidence{
		ChannelID:                   chain,
		ChaincodeName:               endpoint,
		ChaincodeVersion:            "v1",
		Namespace:                   endpoint,
		TxID:                        firstNonEmptyString(stringFromArgs(eventArgs, "crossChainTxId", "cross_chain_tx_id"), "0"),
		BlockHash:                   fixedHashHex("fabric-block|" + chain + "|" + blockString(block)),
		ValidationCode:              "VALID",
		ProposalResponsePayloadHash: hex.EncodeToString(payloadHash[:]),
		RWSetHash:                   hex.EncodeToString(rwHash[:]),
		Identities: []fabricproof.Identity{
			{ID: "org1-peer", MSPID: "Org1MSP", CertificatePEM: org1PEM},
			{ID: "org2-peer", MSPID: "Org2MSP", CertificatePEM: org2PEM},
		},
		Policy: fabricproof.EndorsementPolicy{
			RequiredMSPs:    []string{"Org1MSP", "Org2MSP"},
			MinEndorsements: 2,
		},
		Binding: fabricproof.MetadataBinding{
			ChainID:          fmt.Sprintf("%s:%d", chain, chainID),
			ContractID:       endpoint,
			SchemaHash:       fixedHashHex("schema|" + chain + "|" + endpoint),
			OpID:             firstNonEmptyString(stringFromArgs(eventArgs, "crossChainTxId", "cross_chain_tx_id"), "0"),
			LockEpoch:        block,
			StateVersion:     block,
			StatePayloadHash: hex.EncodeToString(stateHash[:]),
			HashAlgorithm:    "sha256",
		},
	}
	evidence.Endorsements = []fabricproof.Endorsement{
		{IdentityID: "org1-peer", Signature: signFixtureECDSA(org1Key, proposalPayload)},
		{IdentityID: "org2-peer", Signature: signFixtureECDSA(org2Key, proposalPayload)},
	}
	bundle := fabricProductionEvidenceBundle{
		Evidence:                evidence,
		ProposalResponsePayload: hex.EncodeToString(proposalPayload),
		RWSet:                   hex.EncodeToString(rwSet),
		EncodedState:            hex.EncodeToString(encodedState),
		MSPRoots:                []string{rootPEM},
	}
	return json.Marshal(bundle)
}

func makeFixtureRootCA(now time.Time) (*x509.Certificate, *ecdsa.PrivateKey, string, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, "", err
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(now.UnixNano()),
		Subject:               pkix.Name{CommonName: "XSmart fixture root"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, nil, "", err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, "", err
	}
	return cert, key, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), nil
}

func makeFixtureLeaf(root *x509.Certificate, rootKey *ecdsa.PrivateKey, org string, now time.Time) (*x509.Certificate, *ecdsa.PrivateKey, string, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, "", err
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(now.UnixNano()),
		Subject:               pkix.Name{CommonName: org + " peer", Organization: []string{org}},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageAny},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, root, &key.PublicKey, rootKey)
	if err != nil {
		return nil, nil, "", err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, "", err
	}
	return cert, key, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), nil
}

func signFixtureECDSA(key *ecdsa.PrivateKey, payload []byte) string {
	digest := sha256.Sum256(payload)
	sig, _ := ecdsa.SignASN1(rand.Reader, key, digest[:])
	return hex.EncodeToString(sig)
}

func fixedHashHex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
