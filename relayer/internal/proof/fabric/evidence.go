package fabric

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"
	"time"

	ethcrypto "github.com/ethereum/go-ethereum/crypto"
)

type MetadataBinding struct {
	ChainID          string `json:"chain_id"`
	ContractID       string `json:"contract_id"`
	SchemaHash       string `json:"schema_hash"`
	OpID             string `json:"op_id"`
	LockEpoch        uint64 `json:"lock_epoch"`
	StateVersion     uint64 `json:"state_version"`
	StatePayloadHash string `json:"state_payload_hash"`
	HashAlgorithm    string `json:"hash_algorithm"`
}

type Identity struct {
	ID             string `json:"id"`
	MSPID          string `json:"msp_id"`
	CertificatePEM string `json:"certificate_pem"`
}

type Endorsement struct {
	IdentityID string `json:"identity_id"`
	Signature  string `json:"signature"`
}

type EndorsementPolicy struct {
	RequiredMSPs    []string `json:"required_msps"`
	MinEndorsements uint64   `json:"min_endorsements"`
}

type Evidence struct {
	ChannelID                   string            `json:"channel_id"`
	ChaincodeName               string            `json:"chaincode_name"`
	ChaincodeVersion            string            `json:"chaincode_version"`
	Namespace                   string            `json:"namespace"`
	TxID                        string            `json:"tx_id"`
	BlockHash                   string            `json:"block_hash"`
	ValidationCode              string            `json:"validation_code"`
	ProposalResponsePayloadHash string            `json:"proposal_response_payload_hash"`
	RWSetHash                   string            `json:"rw_set_hash"`
	Identities                  []Identity        `json:"identities"`
	Endorsements                []Endorsement     `json:"endorsements"`
	Policy                      EndorsementPolicy `json:"policy"`
	Binding                     MetadataBinding   `json:"binding"`
}

type VerificationOptions struct {
	Roots         *x509.CertPool
	Intermediates *x509.CertPool
	CurrentTime   time.Time
}

type VerificationResult struct {
	AcceptedEndorsements uint64   `json:"accepted_endorsements"`
	AcceptedMSPs         []string `json:"accepted_msps"`
	PublicInputHash      string   `json:"public_input_hash"`
}

func VerifyEvidence(evidence Evidence, proposalResponsePayload, rwSet, encodedState []byte, opts VerificationOptions) (VerificationResult, error) {
	if err := validateStaticEvidence(evidence); err != nil {
		return VerificationResult{}, err
	}
	if err := verifyBytesHash("proposal response payload", evidence.ProposalResponsePayloadHash, proposalResponsePayload); err != nil {
		return VerificationResult{}, err
	}
	if err := verifyBytesHash("rw set", evidence.RWSetHash, rwSet); err != nil {
		return VerificationResult{}, err
	}
	if err := verifyStatePayloadHash(evidence.Binding, encodedState); err != nil {
		return VerificationResult{}, err
	}
	if opts.Roots == nil {
		return VerificationResult{}, errors.New("fabric proof requires MSP root certificate pool")
	}
	if opts.CurrentTime.IsZero() {
		opts.CurrentTime = time.Now()
	}

	identities := make(map[string]Identity, len(evidence.Identities))
	certs := make(map[string]*x509.Certificate, len(evidence.Identities))
	for _, identity := range evidence.Identities {
		id := strings.TrimSpace(identity.ID)
		if id == "" {
			return VerificationResult{}, errors.New("fabric proof identity id is empty")
		}
		if _, exists := identities[id]; exists {
			return VerificationResult{}, fmt.Errorf("fabric proof duplicate identity %q", id)
		}
		cert, err := parseCertificate(identity.CertificatePEM)
		if err != nil {
			return VerificationResult{}, err
		}
		if _, err := cert.Verify(x509.VerifyOptions{
			Roots:         opts.Roots,
			Intermediates: opts.Intermediates,
			CurrentTime:   opts.CurrentTime,
			KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageAny},
		}); err != nil {
			return VerificationResult{}, fmt.Errorf("fabric proof identity %q failed MSP certificate verification: %w", id, err)
		}
		if strings.TrimSpace(identity.MSPID) == "" {
			return VerificationResult{}, fmt.Errorf("fabric proof identity %q has empty MSP ID", id)
		}
		identity.ID = id
		identity.MSPID = strings.TrimSpace(identity.MSPID)
		identities[id] = identity
		certs[id] = cert
	}

	seenIdentities := make(map[string]struct{}, len(evidence.Endorsements))
	acceptedMSPs := make(map[string]struct{}, len(evidence.Endorsements))
	var accepted uint64
	for _, endorsement := range evidence.Endorsements {
		id := strings.TrimSpace(endorsement.IdentityID)
		if id == "" {
			return VerificationResult{}, errors.New("fabric proof endorsement identity id is empty")
		}
		if _, exists := seenIdentities[id]; exists {
			return VerificationResult{}, fmt.Errorf("fabric proof duplicate endorsement from identity %q", id)
		}
		identity, ok := identities[id]
		if !ok {
			return VerificationResult{}, fmt.Errorf("fabric proof endorsement from unknown identity %q", id)
		}
		signature, err := decodeHex(endorsement.Signature, "endorsement signature")
		if err != nil {
			return VerificationResult{}, err
		}
		if err := verifySignature(certs[id], proposalResponsePayload, signature); err != nil {
			return VerificationResult{}, fmt.Errorf("fabric proof endorsement signature from %q rejected: %w", id, err)
		}
		accepted++
		seenIdentities[id] = struct{}{}
		acceptedMSPs[identity.MSPID] = struct{}{}
	}
	if accepted < evidence.Policy.MinEndorsements {
		return VerificationResult{}, fmt.Errorf("fabric proof accepted endorsements %d below policy minimum %d", accepted, evidence.Policy.MinEndorsements)
	}
	for _, requiredMSP := range evidence.Policy.RequiredMSPs {
		requiredMSP = strings.TrimSpace(requiredMSP)
		if requiredMSP == "" {
			return VerificationResult{}, errors.New("fabric proof policy contains empty required MSP")
		}
		if _, ok := acceptedMSPs[requiredMSP]; !ok {
			return VerificationResult{}, fmt.Errorf("fabric proof required MSP %q is not endorsed", requiredMSP)
		}
	}

	publicInputHash, err := PublicInputHash(evidence)
	if err != nil {
		return VerificationResult{}, err
	}
	return VerificationResult{
		AcceptedEndorsements: accepted,
		AcceptedMSPs:         sortedMapKeys(acceptedMSPs),
		PublicInputHash:      publicInputHash,
	}, nil
}

func PublicInputHash(evidence Evidence) (string, error) {
	input := struct {
		ChannelID                   string            `json:"channel_id"`
		ChaincodeName               string            `json:"chaincode_name"`
		ChaincodeVersion            string            `json:"chaincode_version"`
		Namespace                   string            `json:"namespace"`
		TxID                        string            `json:"tx_id"`
		BlockHash                   string            `json:"block_hash"`
		ValidationCode              string            `json:"validation_code"`
		ProposalResponsePayloadHash string            `json:"proposal_response_payload_hash"`
		RWSetHash                   string            `json:"rw_set_hash"`
		Policy                      EndorsementPolicy `json:"policy"`
		Binding                     MetadataBinding   `json:"binding"`
	}{
		ChannelID:                   strings.TrimSpace(evidence.ChannelID),
		ChaincodeName:               strings.TrimSpace(evidence.ChaincodeName),
		ChaincodeVersion:            strings.TrimSpace(evidence.ChaincodeVersion),
		Namespace:                   strings.TrimSpace(evidence.Namespace),
		TxID:                        strings.TrimSpace(evidence.TxID),
		BlockHash:                   normalizeHex(evidence.BlockHash),
		ValidationCode:              strings.TrimSpace(evidence.ValidationCode),
		ProposalResponsePayloadHash: normalizeHex(evidence.ProposalResponsePayloadHash),
		RWSetHash:                   normalizeHex(evidence.RWSetHash),
		Policy:                      evidence.Policy,
		Binding:                     normalizeBinding(evidence.Binding),
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

func validateStaticEvidence(evidence Evidence) error {
	if strings.TrimSpace(evidence.ChannelID) == "" {
		return errors.New("fabric proof channel_id is empty")
	}
	if strings.TrimSpace(evidence.ChaincodeName) == "" {
		return errors.New("fabric proof chaincode_name is empty")
	}
	if strings.TrimSpace(evidence.ChaincodeVersion) == "" {
		return errors.New("fabric proof chaincode_version is empty")
	}
	if strings.TrimSpace(evidence.Namespace) == "" {
		return errors.New("fabric proof namespace is empty")
	}
	if strings.TrimSpace(evidence.TxID) == "" {
		return errors.New("fabric proof tx_id is empty")
	}
	if _, err := decodeFixedHex(evidence.BlockHash, 32, "block hash"); err != nil {
		return err
	}
	if strings.TrimSpace(evidence.ValidationCode) != "VALID" {
		return fmt.Errorf("fabric proof validation code is %q, want VALID", evidence.ValidationCode)
	}
	if _, err := decodeFixedHex(evidence.ProposalResponsePayloadHash, 32, "proposal response payload hash"); err != nil {
		return err
	}
	if _, err := decodeFixedHex(evidence.RWSetHash, 32, "rw set hash"); err != nil {
		return err
	}
	if len(evidence.Identities) == 0 {
		return errors.New("fabric proof identity set is empty")
	}
	if len(evidence.Endorsements) == 0 {
		return errors.New("fabric proof endorsement set is empty")
	}
	if evidence.Policy.MinEndorsements == 0 {
		return errors.New("fabric proof policy minimum is zero")
	}
	if err := validateBinding(evidence.Binding); err != nil {
		return err
	}
	return nil
}

func parseCertificate(pemText string) (*x509.Certificate, error) {
	block, _ := pem.Decode([]byte(pemText))
	if block == nil {
		return nil, errors.New("fabric proof certificate PEM is invalid")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("fabric proof certificate parse failed: %w", err)
	}
	return cert, nil
}

func verifySignature(cert *x509.Certificate, message, signature []byte) error {
	switch pub := cert.PublicKey.(type) {
	case *ecdsa.PublicKey:
		digest := sha256.Sum256(message)
		if !ecdsa.VerifyASN1(pub, digest[:], signature) {
			return errors.New("ECDSA signature verification failed")
		}
		return nil
	case *rsa.PublicKey:
		digest := sha256.Sum256(message)
		return rsa.VerifyPKCS1v15(pub, crypto.SHA256, digest[:], signature)
	case ed25519.PublicKey:
		if !ed25519.Verify(pub, message, signature) {
			return errors.New("Ed25519 signature verification failed")
		}
		return nil
	default:
		return fmt.Errorf("unsupported endorsement public key type %T", pub)
	}
}

func verifyBytesHash(name, expectedHash string, value []byte) error {
	digest := sha256.Sum256(value)
	actual := hex.EncodeToString(digest[:])
	expected := normalizeHex(expectedHash)
	if actual != expected {
		return fmt.Errorf("fabric proof %s hash mismatch: expected %s got %s", name, expected, actual)
	}
	return nil
}

func validateBinding(binding MetadataBinding) error {
	if strings.TrimSpace(binding.ChainID) == "" {
		return errors.New("fabric proof binding chain_id is empty")
	}
	if strings.TrimSpace(binding.ContractID) == "" {
		return errors.New("fabric proof binding contract_id is empty")
	}
	if strings.TrimSpace(binding.OpID) == "" {
		return errors.New("fabric proof binding op_id is empty")
	}
	if binding.LockEpoch == 0 {
		return errors.New("fabric proof binding lock_epoch is zero")
	}
	if binding.StateVersion == 0 {
		return errors.New("fabric proof binding state_version is zero")
	}
	if _, err := decodeFixedHex(binding.SchemaHash, 32, "schema hash"); err != nil {
		return err
	}
	if _, err := decodeFixedHex(binding.StatePayloadHash, 32, "state payload hash"); err != nil {
		return err
	}
	switch strings.ToLower(strings.TrimSpace(binding.HashAlgorithm)) {
	case "sha256", "keccak256":
		return nil
	default:
		return fmt.Errorf("fabric proof unsupported state hash algorithm %q", binding.HashAlgorithm)
	}
}

func verifyStatePayloadHash(binding MetadataBinding, encodedState []byte) error {
	var sum []byte
	switch strings.ToLower(strings.TrimSpace(binding.HashAlgorithm)) {
	case "sha256":
		digest := sha256.Sum256(encodedState)
		sum = digest[:]
	case "keccak256":
		digest := ethcrypto.Keccak256Hash(encodedState)
		sum = digest.Bytes()
	default:
		return fmt.Errorf("fabric proof unsupported state hash algorithm %q", binding.HashAlgorithm)
	}
	expected := normalizeHex(binding.StatePayloadHash)
	actual := hex.EncodeToString(sum)
	if actual != expected {
		return fmt.Errorf("fabric proof state payload hash mismatch: expected %s got %s", expected, actual)
	}
	return nil
}

func normalizeBinding(binding MetadataBinding) MetadataBinding {
	binding.ChainID = strings.TrimSpace(binding.ChainID)
	binding.ContractID = strings.TrimSpace(binding.ContractID)
	binding.SchemaHash = normalizeHex(binding.SchemaHash)
	binding.OpID = strings.TrimSpace(binding.OpID)
	binding.StatePayloadHash = normalizeHex(binding.StatePayloadHash)
	binding.HashAlgorithm = strings.ToLower(strings.TrimSpace(binding.HashAlgorithm))
	return binding
}

func decodeFixedHex(value string, size int, name string) ([]byte, error) {
	decoded, err := decodeHex(value, name)
	if err != nil {
		return nil, err
	}
	if len(decoded) != size {
		return nil, fmt.Errorf("fabric proof invalid %s length: got %d want %d", name, len(decoded), size)
	}
	return decoded, nil
}

func decodeHex(value string, name string) ([]byte, error) {
	decoded, err := hex.DecodeString(normalizeHex(value))
	if err != nil {
		return nil, fmt.Errorf("fabric proof invalid %s hex: %w", name, err)
	}
	return decoded, nil
}

func normalizeHex(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	value = strings.TrimPrefix(value, "0x")
	return value
}

func sortedMapKeys(values map[string]struct{}) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if keys[j] < keys[i] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	return keys
}
