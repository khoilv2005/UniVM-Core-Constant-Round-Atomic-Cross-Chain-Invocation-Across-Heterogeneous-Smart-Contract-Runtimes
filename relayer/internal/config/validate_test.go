package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidateXSmartAcceptsManifestAndWASMChain(t *testing.T) {
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "manifest.json")
	metadataPath := filepath.Join(dir, "xbridge.contract")
	if err := os.WriteFile(manifestPath, []byte(`{"call_tree_blob":"0x01","translation_keys":[],"peer_ir_hashes":[]}`), 0o600); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	if err := os.WriteFile(metadataPath, []byte(`{}`), 0o600); err != nil {
		t.Fatalf("write metadata: %v", err)
	}

	cfg := &Config{
		Title:    "xsmart",
		Protocol: "xsmart",
		Chains: map[string]ChainConfig{
			"bc1": {
				Name:    "bc1",
				VM:      "evm",
				ChainID: 1,
				RPCURL:  "http://127.0.0.1:8545",
			},
			"bc2": {
				Name:            "bc2",
				VM:              "wasm",
				ChainID:         1338,
				RPCURL:          "http://127.0.0.1:9944",
				MetadataPath:    metadataPath,
				AccountEndpoint: "5FTestAccount",
			},
		},
		Contracts: ContractsConfig{
			XSmart: map[string]XSmartChainContracts{
				"bc1": {
					XBridgingContract: "0x1111111111111111111111111111111111111111",
					UBTLRegistry:      "0x2222222222222222222222222222222222222222",
					RelayerManager:    "0x3333333333333333333333333333333333333333",
				},
			},
		},
		Relayer: RelayerConfig{
			ID:             "xsmart-relayer",
			Workers:        1,
			PrivateKey:     "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			CheckpointFile: filepath.Join(dir, "ckpt.json"),
		},
		XSmart: XSmartConfig{
			Manifest: manifestPath,
		},
	}

	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestValidateXSmartRejectsMissingWASMMetadata(t *testing.T) {
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(manifestPath, []byte(`{"call_tree_blob":"0x01","translation_keys":[],"peer_ir_hashes":[]}`), 0o600); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	cfg := &Config{
		Title:    "xsmart",
		Protocol: "xsmart",
		Chains: map[string]ChainConfig{
			"bc1": {
				Name:    "bc1",
				VM:      "evm",
				ChainID: 1,
				RPCURL:  "http://127.0.0.1:8545",
			},
			"bc2": {
				Name:            "bc2",
				VM:              "wasm",
				ChainID:         1338,
				RPCURL:          "http://127.0.0.1:9944",
				AccountEndpoint: "5FTestAccount",
			},
		},
		Contracts: ContractsConfig{
			XSmart: map[string]XSmartChainContracts{
				"bc1": {
					XBridgingContract: "0x1111111111111111111111111111111111111111",
					UBTLRegistry:      "0x2222222222222222222222222222222222222222",
					RelayerManager:    "0x3333333333333333333333333333333333333333",
				},
			},
		},
		Relayer: RelayerConfig{
			ID:             "xsmart-relayer",
			Workers:        1,
			PrivateKey:     "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			CheckpointFile: filepath.Join(dir, "ckpt.json"),
		},
		XSmart: XSmartConfig{
			Manifest: manifestPath,
		},
	}

	if err := cfg.Validate(); err == nil {
		t.Fatalf("Validate() expected error for missing metadata_path")
	}
}

func TestNormalizeCopiesEndpointAliasIntoAccountEndpoint(t *testing.T) {
	cfg := &Config{
		Proof: ProofConfig{ConfirmationBlocks: 4},
		Chains: map[string]ChainConfig{
			"bc2": {
				Name:     "bc2",
				VM:       "wasm",
				ChainID:  1338,
				RPCURL:   "http://127.0.0.1:9944",
				Endpoint: "5FEndpointAlias",
			},
		},
	}

	cfg.normalize()

	chain := cfg.Chains["bc2"]
	if chain.AccountEndpoint != "5FEndpointAlias" {
		t.Fatalf("expected AccountEndpoint to be copied from Endpoint, got %q", chain.AccountEndpoint)
	}
	if chain.FinalityBlocks != 4 {
		t.Fatalf("expected FinalityBlocks=4, got %d", chain.FinalityBlocks)
	}
}

func TestNormalizeAcceptsSubstrateProofMode(t *testing.T) {
	cfg := &Config{
		Proof: ProofConfig{Mode: "zk-substrate"},
	}

	cfg.normalize()

	if cfg.Proof.Mode != "zk_substrate" {
		t.Fatalf("expected zk_substrate mode, got %q", cfg.Proof.Mode)
	}
	if !cfg.Proof.RequireNonEVMProofs {
		t.Fatalf("zk_substrate mode must require non-EVM proofs")
	}
}

func TestNormalizeAcceptsFabricProofMode(t *testing.T) {
	cfg := &Config{
		Proof: ProofConfig{Mode: "fabric-proof"},
	}

	cfg.normalize()

	if cfg.Proof.Mode != "zk_fabric" {
		t.Fatalf("expected zk_fabric mode, got %q", cfg.Proof.Mode)
	}
	if !cfg.Proof.RequireNonEVMProofs {
		t.Fatalf("zk_fabric mode must require non-EVM proofs")
	}
}

func TestNormalizeAcceptsBothProofMode(t *testing.T) {
	cfg := &Config{
		Proof: ProofConfig{Mode: "zk-both"},
	}

	cfg.normalize()

	if cfg.Proof.Mode != "zk_both" {
		t.Fatalf("expected zk_both mode, got %q", cfg.Proof.Mode)
	}
	if !cfg.Proof.RequireNonEVMProofs {
		t.Fatalf("zk_both mode must require non-EVM proofs")
	}
}

func TestNormalizeAcceptsProductionProofMode(t *testing.T) {
	cfg := &Config{
		Proof: ProofConfig{Mode: "production-proof"},
	}

	cfg.normalize()

	if cfg.Proof.Mode != "production_proof" {
		t.Fatalf("expected production_proof mode, got %q", cfg.Proof.Mode)
	}
	if !cfg.Proof.RequireNonEVMProofs {
		t.Fatalf("production_proof mode must require non-EVM proofs")
	}
}

func TestNormalizeAcceptsSuccinctProofModes(t *testing.T) {
	for raw, want := range map[string]string{
		"sp1":            "succinct_sp1",
		"succinct-risc0": "succinct_risc0",
	} {
		cfg := Config{Protocol: "xsmart"}
		cfg.Proof.Mode = raw
		cfg.normalize()
		if cfg.Proof.Mode != want {
			t.Fatalf("expected %s mode, got %q", want, cfg.Proof.Mode)
		}
		if !cfg.Proof.RequireNonEVMProofs {
			t.Fatalf("%s mode must require non-EVM proofs", want)
		}
	}
}

func TestValidateFabricGatewayConfigAcceptsResolvedPaths(t *testing.T) {
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "manifest.json")
	metadataPath := filepath.Join(dir, "xbridge.contract")
	certPath := filepath.Join(dir, "user.crt")
	keyPath := filepath.Join(dir, "user.key")
	tlsPath := filepath.Join(dir, "peer-tls.crt")
	for _, file := range []string{manifestPath, metadataPath, certPath, keyPath, tlsPath} {
		if err := os.WriteFile(file, []byte("{}"), 0o600); err != nil {
			t.Fatalf("write %s: %v", file, err)
		}
	}

	cfg := &Config{
		Title:    "xsmart",
		Protocol: "xsmart",
		Chains: map[string]ChainConfig{
			"bc1": {
				Name:    "bc1",
				VM:      "evm",
				ChainID: 1,
				RPCURL:  "http://127.0.0.1:8545",
			},
			"bc2": {
				Name:            "bc2",
				VM:              "wasm",
				ChainID:         1338,
				RPCURL:          "http://127.0.0.1:9944",
				MetadataPath:    metadataPath,
				AccountEndpoint: "5FTestAccount",
			},
			"bc3": {
				Name:                  "bc3",
				VM:                    "fabric",
				ChainID:               3,
				AccountEndpoint:       "xbridge_bc3",
				FabricGatewayEndpoint: "peer0.org1.example.com:7051",
				FabricChannel:         "mychannel",
				FabricChaincode:       "hotel-booking",
				FabricMSPID:           "Org1MSP",
				FabricUserCertPath:    certPath,
				FabricUserKeyPath:     keyPath,
				FabricTLSCertPath:     tlsPath,
				FabricPeerName:        "peer0.org1.example.com",
			},
		},
		Contracts: ContractsConfig{
			XSmart: map[string]XSmartChainContracts{
				"bc1": {
					XBridgingContract: "0x1111111111111111111111111111111111111111",
					UBTLRegistry:      "0x2222222222222222222222222222222222222222",
					RelayerManager:    "0x3333333333333333333333333333333333333333",
				},
			},
		},
		Relayer: RelayerConfig{
			ID:             "xsmart-relayer",
			Workers:        1,
			PrivateKey:     "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			CheckpointFile: filepath.Join(dir, "ckpt.json"),
		},
		XSmart: XSmartConfig{
			Manifest: manifestPath,
		},
	}

	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}
