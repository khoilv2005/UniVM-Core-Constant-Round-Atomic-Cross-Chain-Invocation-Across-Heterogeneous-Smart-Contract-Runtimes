package fabric

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"
)

func TestVerifyEvidenceAcceptsMSPPolicy(t *testing.T) {
	fixture := makeFabricFixture(t)

	result, err := VerifyEvidence(fixture.evidence, fixture.payload, fixture.rwSet, fixture.state, fixture.options)
	if err != nil {
		t.Fatalf("VerifyEvidence returned error: %v", err)
	}
	if result.AcceptedEndorsements != 2 {
		t.Fatalf("unexpected endorsement count: %+v", result)
	}
	if strings.Join(result.AcceptedMSPs, ",") != "Org1MSP,Org2MSP" {
		t.Fatalf("unexpected MSP list: %+v", result.AcceptedMSPs)
	}
	if result.PublicInputHash == "" {
		t.Fatalf("public input hash is empty")
	}
}

func TestVerifyEvidenceRejectsBadEndorsementSignature(t *testing.T) {
	fixture := makeFabricFixture(t)
	fixture.evidence.Endorsements[0].Signature = fixture.evidence.Endorsements[1].Signature

	_, err := VerifyEvidence(fixture.evidence, fixture.payload, fixture.rwSet, fixture.state, fixture.options)
	if err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("expected signature error, got %v", err)
	}
}

func TestVerifyEvidenceRejectsUnsatisfiedPolicy(t *testing.T) {
	fixture := makeFabricFixture(t)
	fixture.evidence.Endorsements = fixture.evidence.Endorsements[:1]

	_, err := VerifyEvidence(fixture.evidence, fixture.payload, fixture.rwSet, fixture.state, fixture.options)
	if err == nil || !strings.Contains(err.Error(), "below policy minimum") {
		t.Fatalf("expected policy error, got %v", err)
	}
}

func TestVerifyEvidenceRejectsRWSetMismatch(t *testing.T) {
	fixture := makeFabricFixture(t)

	_, err := VerifyEvidence(fixture.evidence, fixture.payload, []byte("tampered-rw-set"), fixture.state, fixture.options)
	if err == nil || !strings.Contains(err.Error(), "rw set hash mismatch") {
		t.Fatalf("expected rw-set mismatch, got %v", err)
	}
}

func TestVerifyEvidenceRejectsStatePayloadMismatch(t *testing.T) {
	fixture := makeFabricFixture(t)

	_, err := VerifyEvidence(fixture.evidence, fixture.payload, fixture.rwSet, []byte("tampered-state"), fixture.options)
	if err == nil || !strings.Contains(err.Error(), "state payload hash mismatch") {
		t.Fatalf("expected state payload mismatch, got %v", err)
	}
}

type fabricFixture struct {
	evidence Evidence
	payload  []byte
	rwSet    []byte
	state    []byte
	options  VerificationOptions
}

func makeFabricFixture(t *testing.T) fabricFixture {
	t.Helper()
	now := time.Date(2026, 5, 2, 12, 0, 0, 0, time.UTC)
	rootCert, rootKey, rootPEM := makeRootCA(t, now)
	org1Cert, org1Key, org1PEM := makeLeafCert(t, rootCert, rootKey, "Org1MSP", now)
	org2Cert, org2Key, org2PEM := makeLeafCert(t, rootCert, rootKey, "Org2MSP", now)

	_ = org1Cert
	_ = org2Cert
	_ = rootPEM

	payload := []byte("proposal-response-payload")
	rwSet := []byte("rw-set")
	state := []byte("vassp-state")
	payloadHash := sha256.Sum256(payload)
	rwSetHash := sha256.Sum256(rwSet)
	stateHash := sha256.Sum256(state)

	roots := x509.NewCertPool()
	roots.AddCert(rootCert)

	evidence := Evidence{
		ChannelID:                   "booking-channel",
		ChaincodeName:               "hotel",
		ChaincodeVersion:            "v1",
		Namespace:                   "hotel",
		TxID:                        "tx-1",
		BlockHash:                   fixedHex("fabric-block", 32),
		ValidationCode:              "VALID",
		ProposalResponsePayloadHash: hex.EncodeToString(payloadHash[:]),
		RWSetHash:                   hex.EncodeToString(rwSetHash[:]),
		Identities: []Identity{
			{ID: "org1-peer", MSPID: "Org1MSP", CertificatePEM: org1PEM},
			{ID: "org2-peer", MSPID: "Org2MSP", CertificatePEM: org2PEM},
		},
		Policy: EndorsementPolicy{
			RequiredMSPs:    []string{"Org1MSP", "Org2MSP"},
			MinEndorsements: 2,
		},
		Binding: MetadataBinding{
			ChainID:          "fabric-testnet",
			ContractID:       "hotel",
			SchemaHash:       fixedHex("fabric-schema", 32),
			OpID:             "op-1",
			LockEpoch:        3,
			StateVersion:     4,
			StatePayloadHash: hex.EncodeToString(stateHash[:]),
			HashAlgorithm:    "sha256",
		},
	}
	evidence.Endorsements = []Endorsement{
		{IdentityID: "org1-peer", Signature: signECDSA(t, org1Key, payload)},
		{IdentityID: "org2-peer", Signature: signECDSA(t, org2Key, payload)},
	}

	return fabricFixture{
		evidence: evidence,
		payload:  payload,
		rwSet:    rwSet,
		state:    state,
		options: VerificationOptions{
			Roots:       roots,
			CurrentTime: now,
		},
	}
}

func makeRootCA(t *testing.T, now time.Time) (*x509.Certificate, *ecdsa.PrivateKey, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate root key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Test Fabric Root"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create root certificate: %v", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse root certificate: %v", err)
	}
	return cert, key, pemString("CERTIFICATE", der)
}

func makeLeafCert(t *testing.T, rootCert *x509.Certificate, rootKey *ecdsa.PrivateKey, org string, now time.Time) (*x509.Certificate, *ecdsa.PrivateKey, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate leaf key: %v", err)
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
	der, err := x509.CreateCertificate(rand.Reader, template, rootCert, &key.PublicKey, rootKey)
	if err != nil {
		t.Fatalf("create leaf certificate: %v", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse leaf certificate: %v", err)
	}
	return cert, key, pemString("CERTIFICATE", der)
}

func signECDSA(t *testing.T, key *ecdsa.PrivateKey, payload []byte) string {
	t.Helper()
	digest := sha256.Sum256(payload)
	sig, err := ecdsa.SignASN1(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatalf("sign payload: %v", err)
	}
	return hex.EncodeToString(sig)
}

func pemString(kind string, der []byte) string {
	return string(pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: der}))
}

func fixedHex(label string, size int) string {
	sum := sha256.Sum256([]byte(label))
	value := hex.EncodeToString(sum[:])
	for len(value) < size*2 {
		value += value
	}
	return value[:size*2]
}
