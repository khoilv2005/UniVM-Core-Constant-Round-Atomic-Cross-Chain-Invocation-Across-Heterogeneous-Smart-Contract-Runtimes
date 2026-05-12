package transport

import (
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"strings"
)

func evidenceBytesFromArgs(args map[string]any, keys ...string) ([]byte, bool) {
	for _, key := range keys {
		value, ok := args[key]
		if !ok {
			continue
		}
		if out, ok := bytesFromEvidenceValue(value); ok {
			return out, true
		}
	}
	return nil, false
}

func bytesFromEvidenceValue(value any) ([]byte, bool) {
	switch v := value.(type) {
	case []byte:
		return v, len(v) > 0
	case json.RawMessage:
		return v, len(v) > 0
	case string:
		v = strings.TrimSpace(v)
		if v == "" {
			return nil, false
		}
		hexText := strings.TrimPrefix(v, "0x")
		if decoded, err := hex.DecodeString(hexText); err == nil {
			return decoded, len(decoded) > 0
		}
		return []byte(v), true
	default:
		raw, err := json.Marshal(v)
		if err != nil || len(raw) == 0 || string(raw) == "null" {
			return nil, false
		}
		return raw, true
	}
}

func certPoolFromPEMList(values []string) (*x509.CertPool, error) {
	pool := x509.NewCertPool()
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		block, _ := pem.Decode([]byte(value))
		if block == nil {
			return nil, fmt.Errorf("invalid certificate PEM in production evidence bundle")
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse production evidence certificate: %w", err)
		}
		pool.AddCert(cert)
	}
	return pool, nil
}
