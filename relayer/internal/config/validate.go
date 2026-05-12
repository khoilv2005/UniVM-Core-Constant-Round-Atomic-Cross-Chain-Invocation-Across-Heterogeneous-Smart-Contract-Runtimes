package config

import (
	"fmt"
	"os"
	"strings"

	"github.com/ethereum/go-ethereum/common"
)

func (c *Config) Validate() error {
	if strings.TrimSpace(c.Title) == "" {
		return fmt.Errorf("config title is required")
	}
	if !c.ProtocolName().Valid() {
		return fmt.Errorf("unsupported protocol %q", c.Protocol)
	}
	if strings.TrimSpace(c.Relayer.ID) == "" {
		return fmt.Errorf("relayer.id is required")
	}
	if strings.TrimSpace(c.Relayer.PrivateKey) == "" {
		return fmt.Errorf("relayer.private_key is required")
	}
	if strings.TrimSpace(c.Relayer.CheckpointFile) == "" {
		return fmt.Errorf("relayer.checkpoint_file is required")
	}
	if c.Relayer.Workers <= 0 {
		return fmt.Errorf("relayer.workers must be > 0")
	}
	if len(c.Chains) == 0 {
		return fmt.Errorf("at least one chain is required")
	}

	for chainKey, chain := range c.Chains {
		if chain.Name == "" {
			return fmt.Errorf("chain %s name is required", chainKey)
		}
		if chain.ChainID == 0 {
			return fmt.Errorf("chain %s chain_id is required", chainKey)
		}
		switch strings.ToLower(strings.TrimSpace(chain.VM)) {
		case "", "evm":
			if chain.RPCURL == "" && chain.HTTPURL == "" {
				return fmt.Errorf("chain %s rpc_url or http_url is required for evm chains", chainKey)
			}
		case "wasm":
			if chain.RPCURL == "" && chain.WSURL == "" && chain.HTTPURL == "" {
				return fmt.Errorf("chain %s requires at least one endpoint url", chainKey)
			}
		case "fabric":
			if chain.RPCURL == "" && chain.WSURL == "" && chain.HTTPURL == "" && !chain.hasFabricGatewayConfig() {
				return fmt.Errorf("chain %s requires simulator http/rpc url or fabric gateway config", chainKey)
			}
			if chain.hasFabricGatewayConfig() {
				if strings.TrimSpace(chain.FabricGatewayEndpoint) == "" {
					return fmt.Errorf("chain %s fabric_gateway_endpoint is required when using fabric gateway config", chainKey)
				}
				if strings.TrimSpace(chain.FabricChannel) == "" {
					return fmt.Errorf("chain %s fabric_channel is required when using fabric gateway config", chainKey)
				}
				if strings.TrimSpace(chain.FabricChaincode) == "" {
					return fmt.Errorf("chain %s fabric_chaincode is required when using fabric gateway config", chainKey)
				}
				if strings.TrimSpace(chain.FabricMSPID) == "" {
					return fmt.Errorf("chain %s fabric_msp_id is required when using fabric gateway config", chainKey)
				}
				if strings.TrimSpace(chain.FabricUserCertPath) == "" {
					return fmt.Errorf("chain %s fabric_user_cert_path is required when using fabric gateway config", chainKey)
				}
				if strings.TrimSpace(chain.FabricUserKeyPath) == "" {
					return fmt.Errorf("chain %s fabric_user_key_path is required when using fabric gateway config", chainKey)
				}
				if strings.TrimSpace(chain.FabricTLSCertPath) == "" {
					return fmt.Errorf("chain %s fabric_tls_cert_path is required when using fabric gateway config", chainKey)
				}
				for _, p := range []struct {
					label string
					path  string
				}{
					{label: "fabric_user_cert_path", path: chain.FabricUserCertPath},
					{label: "fabric_user_key_path", path: chain.FabricUserKeyPath},
					{label: "fabric_tls_cert_path", path: chain.FabricTLSCertPath},
				} {
					if _, err := os.Stat(p.path); err != nil {
						return fmt.Errorf("chain %s %s: %w", chainKey, p.label, err)
					}
				}
			}
		default:
			return fmt.Errorf("chain %s has unsupported vm %q", chainKey, chain.VM)
		}
	}

	for _, ref := range c.ContractRefs() {
		if !common.IsHexAddress(ref.Address) {
			return fmt.Errorf("invalid address %s for %s/%s", ref.Address, ref.ChainKey, ref.Name)
		}
		if common.HexToAddress(ref.Address) == (common.Address{}) {
			return fmt.Errorf("zero address for %s/%s", ref.ChainKey, ref.Name)
		}
	}

	switch c.ProtocolName() {
	case "xsmart":
		if c.XSmart.Manifest == "" {
			return fmt.Errorf("xsmart.manifest is required")
		}
		if _, err := os.Stat(c.XSmart.Manifest); err != nil {
			return fmt.Errorf("xsmart.manifest: %w", err)
		}
		root, ok := c.Contracts.XSmart["bc1"]
		if !ok {
			return fmt.Errorf("contracts.xsmart.bc1 is required")
		}
		if !common.IsHexAddress(root.XBridgingContract) {
			return fmt.Errorf("contracts.xsmart.bc1.xbridging_contract is required")
		}
		if !common.IsHexAddress(root.UBTLRegistry) {
			return fmt.Errorf("contracts.xsmart.bc1.ubtl_registry is required")
		}
		if !common.IsHexAddress(root.RelayerManager) {
			return fmt.Errorf("contracts.xsmart.bc1.relayer_manager is required")
		}
		hasRemoteTarget := false
		for chainKey, chain := range c.Chains {
			if chainKey != "bc1" {
				hasRemoteTarget = true
			}
			if !strings.EqualFold(chain.VM, "wasm") {
				continue
			}
			if strings.TrimSpace(chain.MetadataPath) == "" {
				return fmt.Errorf("chain %s metadata_path is required for wasm chains", chainKey)
			}
			if _, err := os.Stat(chain.MetadataPath); err != nil {
				return fmt.Errorf("chain %s metadata_path: %w", chainKey, err)
			}
			if strings.TrimSpace(chain.EffectiveEndpoint()) == "" {
				return fmt.Errorf("chain %s endpoint/account_endpoint is required for wasm chains", chainKey)
			}
		}
		if !hasRemoteTarget {
			return fmt.Errorf("xsmart requires at least one remote chain")
		}
	case "atom":
		if c.Atom.WriteManifest == "" {
			return fmt.Errorf("atom.write_manifest is required")
		}
		if _, err := os.Stat(c.Atom.WriteManifest); err != nil {
			return fmt.Errorf("atom.write_manifest: %w", err)
		}
		if c.Atom.ReadManifest != "" {
			if _, err := os.Stat(c.Atom.ReadManifest); err != nil {
				return fmt.Errorf("atom.read_manifest: %w", err)
			}
		}
		for i, key := range c.Atom.JudgeKeys {
			if !isHexKey(key) {
				return fmt.Errorf("atom.judge_keys[%d] must be 32-byte hex", i)
			}
		}
	case "gpact":
		if c.GPACT.Manifest == "" {
			return fmt.Errorf("gpact.manifest is required")
		}
		if _, err := os.Stat(c.GPACT.Manifest); err != nil {
			return fmt.Errorf("gpact.manifest: %w", err)
		}
		for i, key := range c.GPACT.SignerKeys {
			if !isHexKey(key) {
				return fmt.Errorf("gpact.signer_keys[%d] must be 32-byte hex", i)
			}
		}
	}

	return nil
}

func (c ChainConfig) EffectiveEndpoint() string {
	if strings.TrimSpace(c.AccountEndpoint) != "" {
		return strings.TrimSpace(c.AccountEndpoint)
	}
	return strings.TrimSpace(c.Endpoint)
}

func (c ChainConfig) hasFabricGatewayConfig() bool {
	fields := []string{
		c.FabricGatewayEndpoint,
		c.FabricChannel,
		c.FabricChaincode,
		c.FabricMSPID,
		c.FabricUserCertPath,
		c.FabricUserKeyPath,
		c.FabricTLSCertPath,
		c.FabricPeerName,
	}
	for _, field := range fields {
		if strings.TrimSpace(field) != "" {
			return true
		}
	}
	return false
}

func isHexKey(raw string) bool {
	key := strings.TrimPrefix(strings.TrimSpace(raw), "0x")
	if len(key) != 64 {
		return false
	}
	for _, ch := range key {
		switch {
		case ch >= '0' && ch <= '9':
		case ch >= 'a' && ch <= 'f':
		case ch >= 'A' && ch <= 'F':
		default:
			return false
		}
	}
	return true
}
