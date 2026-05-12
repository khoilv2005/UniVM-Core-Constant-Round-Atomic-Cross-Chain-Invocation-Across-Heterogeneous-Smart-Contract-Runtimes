package config

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	protocolcommon "github.com/xsmart/relayer/internal/protocol/common"
	"gopkg.in/yaml.v3"
)

type Config struct {
	Title     string                 `yaml:"title"`
	Protocol  string                 `yaml:"protocol"`
	Chains    map[string]ChainConfig `yaml:"chains"`
	Contracts ContractsConfig        `yaml:"contracts"`
	Relayer   RelayerConfig          `yaml:"relayer"`
	Proof     ProofConfig            `yaml:"proof"`
	Relay     RelayConfig            `yaml:"relay"`
	XSmart    XSmartConfig           `yaml:"xsmart"`
	Atom      AtomConfig             `yaml:"atom"`
	GPACT     GPACTConfig            `yaml:"gpact"`
}

type RelayerConfig struct {
	ID             string `yaml:"id"`
	LogLevel       string `yaml:"log_level"`
	Workers        int    `yaml:"workers"`
	PrivateKey     string `yaml:"private_key"`
	CheckpointFile string `yaml:"checkpoint_file"`
}

type ChainConfig struct {
	Name                  string              `yaml:"name"`
	VM                    string              `yaml:"vm"`
	ChainID               uint64              `yaml:"chain_id"`
	RPCURL                string              `yaml:"rpc_url"`
	HTTPURL               string              `yaml:"http_url"`
	WSURL                 string              `yaml:"ws_url"`
	Endpoint              string              `yaml:"endpoint"`
	MetadataPath          string              `yaml:"metadata_path"`
	AccountEndpoint       string              `yaml:"account_endpoint"`
	SubmitterURI          string              `yaml:"submitter_uri"`
	FinalityBlocks        uint64              `yaml:"finality_blocks"`
	FabricGatewayEndpoint string              `yaml:"fabric_gateway_endpoint"`
	FabricChannel         string              `yaml:"fabric_channel"`
	FabricChaincode       string              `yaml:"fabric_chaincode"`
	FabricMSPID           string              `yaml:"fabric_msp_id"`
	FabricUserCertPath    string              `yaml:"fabric_user_cert_path"`
	FabricUserKeyPath     string              `yaml:"fabric_user_key_path"`
	FabricTLSCertPath     string              `yaml:"fabric_tls_cert_path"`
	FabricPeerName        string              `yaml:"fabric_peer_name"`
	GasLimit              uint64              `yaml:"gas_limit"`
	GasPriceGwei          uint64              `yaml:"gas_price_gwei"`
	ContractAddress       string              `yaml:"contract_address"`
	TravelDAppAddress     string              `yaml:"travel_dapp_address"`
	ServiceStateContracts []string            `yaml:"-"`
	ServiceStateGroups    map[string][]string `yaml:"service_state_contracts"`
	AtomServiceAddress    string              `yaml:"atom_service_address"`
	AtomEntryAddress      string              `yaml:"atom_entry_address"`
	AtomRegistryAddress   string              `yaml:"atom_registry_address"`
	AtomCommunityAddress  string              `yaml:"atom_community_address"`
	AtomHotelAddress      string              `yaml:"atom_hotel_address"`
	AtomTrainAddress      string              `yaml:"atom_train_address"`
	AtomFlightAddress     string              `yaml:"atom_flight_address"`
	AtomTaxiAddress       string              `yaml:"atom_taxi_address"`
	GPACTControlAddress   string              `yaml:"gpact_control_address"`
	GPACTAppAddress       string              `yaml:"gpact_app_address"`
	GPACTSignerRegistry   string              `yaml:"gpact_signer_registry_address"`
	Labels                map[string]string   `yaml:"labels"`
}

type ContractsConfig struct {
	XSmart     map[string]XSmartChainContracts     `yaml:"xsmart"`
	IntegrateX map[string]IntegrateXChainContracts `yaml:"integratex"`
	Atom       map[string]AtomChainContracts       `yaml:"atom"`
	GPACT      map[string]GPACTChainContracts      `yaml:"gpact"`
}

type XSmartChainContracts struct {
	XBridgingContract string `yaml:"xbridging_contract"`
	UBTLRegistry      string `yaml:"ubtl_registry"`
	RelayerManager    string `yaml:"relayer_manager"`
	LightClient       string `yaml:"light_client"`
}

type IntegrateXChainContracts struct {
	BridgeingContract string   `yaml:"bridging_contract"`
	TravelDApp        string   `yaml:"travel_dapp"`
	RelayerManager    string   `yaml:"relayer_manager"`
	StateContracts    []string `yaml:"state_contracts"`
}

type AtomChainContracts struct {
	AtomService     string `yaml:"atom_service"`
	AtomTravelEntry string `yaml:"atom_travel_entry"`
	AtomRemoteReg   string `yaml:"atom_remote_registry"`
	AtomCommunity   string `yaml:"atom_community"`
	AtomHotel       string `yaml:"atom_hotel"`
	AtomTrain       string `yaml:"atom_train"`
	AtomFlight      string `yaml:"atom_flight"`
	AtomTaxi        string `yaml:"atom_taxi"`
}

type GPACTChainContracts struct {
	GPACTControl        string `yaml:"gpact_control"`
	GPACTApp            string `yaml:"gpact_app"`
	GPACTSignerRegistry string `yaml:"gpact_signer_registry"`
}

type ProofConfig struct {
	Mode                string `yaml:"mode"`
	RequireNonEVMProofs bool   `yaml:"require_non_evm_proofs"`
	MaxRetry            int    `yaml:"max_retry"`
	RetryDelayMs        int    `yaml:"retry_delay_ms"`
	ConfirmationBlocks  int    `yaml:"confirmation_blocks"`
}

type RelayConfig struct {
	TimeoutSeconds int `yaml:"timeout_seconds"`
	MaxPending     int `yaml:"max_pending"`
}

type XSmartConfig struct {
	Manifest          string `yaml:"manifest"`
	ServiceID         string `yaml:"service_id"`
	WASMLockNum       uint64 `yaml:"wasm_lock_num"`
	WASMTimeoutBlocks uint64 `yaml:"wasm_timeout_blocks"`
}

type AtomConfig struct {
	WriteManifest     string   `yaml:"write_manifest"`
	WriteOnlyManifest string   `yaml:"write_only_manifest"`
	ReadManifest      string   `yaml:"read_manifest"`
	ReadWriteManifest string   `yaml:"read_write_manifest"`
	JudgeKeys         []string `yaml:"judge_keys"`
	JudgePrivateKeys  []string `yaml:"judge_private_keys"`
}

type GPACTConfig struct {
	Manifest          string   `yaml:"manifest"`
	SignerKeys        []string `yaml:"signer_keys"`
	SignerPrivateKeys []string `yaml:"signer_private_keys"`
	EventTransferMode string   `yaml:"event_transfer_mode"`
	ExecutionMode     string   `yaml:"execution_mode"`
}

type ContractRef struct {
	Protocol protocolcommon.ProtocolName
	ChainKey string
	ChainID  uint64
	Name     string
	Address  string
}

func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var cfg Config
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return nil, err
	}

	cfg.normalize()
	cfg.resolvePaths(filepath.Dir(path))
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (c *Config) normalize() {
	c.Protocol = string(protocolcommon.NormalizeProtocol(c.Protocol))

	if c.Relayer.LogLevel == "" {
		c.Relayer.LogLevel = "info"
	}
	if c.Relayer.Workers <= 0 {
		c.Relayer.Workers = 4
	}
	if c.Relayer.CheckpointFile == "" {
		c.Relayer.CheckpointFile = filepath.Join(".", "var", fmt.Sprintf("%s-ckpt.json", c.Protocol))
	}
	if c.Proof.MaxRetry <= 0 {
		c.Proof.MaxRetry = 3
	}
	if c.Proof.RetryDelayMs <= 0 {
		c.Proof.RetryDelayMs = 1000
	}
	c.Proof.Mode = strings.ToLower(strings.TrimSpace(c.Proof.Mode))
	if c.Proof.Mode == "" {
		c.Proof.Mode = "trusted_normalized"
	}
	if c.Proof.Mode == "verified" || c.Proof.Mode == "verified_adapter" || c.Proof.Mode == "verified-adapter" || c.Proof.Mode == "component-verified" || c.Proof.Mode == "component_verified_adapter" {
		c.Proof.Mode = "component_verified"
	}
	if c.Proof.Mode == "trusted" || c.Proof.Mode == "trusted_adapter" || c.Proof.Mode == "trusted-adapter" {
		c.Proof.Mode = "trusted_normalized"
	}
	if c.Proof.Mode == "trust_minimized" || c.Proof.Mode == "trust-minimized" {
		c.Proof.Mode = "trust_minimized"
	}
	if c.Proof.Mode == "zk-substrate" || c.Proof.Mode == "zk_substrate" || c.Proof.Mode == "substrate_proof" || c.Proof.Mode == "proof_backed_substrate" {
		c.Proof.Mode = "zk_substrate"
	}
	if c.Proof.Mode == "zk-fabric" || c.Proof.Mode == "zk_fabric" || c.Proof.Mode == "fabric-proof" || c.Proof.Mode == "fabric_proof" || c.Proof.Mode == "proof_backed_fabric" {
		c.Proof.Mode = "zk_fabric"
	}
	if c.Proof.Mode == "zk-both" || c.Proof.Mode == "zk_both" || c.Proof.Mode == "both" || c.Proof.Mode == "proof_backed_both" || c.Proof.Mode == "both_proof" {
		c.Proof.Mode = "zk_both"
	}
	if c.Proof.Mode == "production" || c.Proof.Mode == "production-proof" || c.Proof.Mode == "production_proof" || c.Proof.Mode == "trust_minimized_production" {
		c.Proof.Mode = "production_proof"
	}
	if c.Proof.Mode == "sp1" || c.Proof.Mode == "succinct-sp1" || c.Proof.Mode == "succinct_sp1" || c.Proof.Mode == "zk_sp1" {
		c.Proof.Mode = "succinct_sp1"
	}
	if c.Proof.Mode == "risc0" || c.Proof.Mode == "risc_zero" || c.Proof.Mode == "succinct-risc0" || c.Proof.Mode == "succinct_risc0" || c.Proof.Mode == "zk_risc0" {
		c.Proof.Mode = "succinct_risc0"
	}
	if c.Proof.Mode == "component_verified" || c.Proof.Mode == "trust_minimized" || c.Proof.Mode == "zk_substrate" || c.Proof.Mode == "zk_fabric" || c.Proof.Mode == "zk_both" || c.Proof.Mode == "production_proof" || c.Proof.Mode == "succinct_sp1" || c.Proof.Mode == "succinct_risc0" {
		c.Proof.RequireNonEVMProofs = true
	}
	if c.Relay.TimeoutSeconds <= 0 {
		c.Relay.TimeoutSeconds = 60
	}
	if c.Relay.MaxPending <= 0 {
		c.Relay.MaxPending = 100
	}
	if c.Chains == nil {
		c.Chains = map[string]ChainConfig{}
	}

	for chainKey, chain := range c.Chains {
		if chain.Name == "" {
			chain.Name = chainKey
		}
		if chain.VM == "" {
			chain.VM = "evm"
		}
		if chain.HTTPURL == "" {
			chain.HTTPURL = chain.RPCURL
		}
		if chain.WSURL == "" && strings.HasPrefix(strings.ToLower(chain.RPCURL), "ws") {
			chain.WSURL = chain.RPCURL
		}
		if strings.TrimSpace(chain.AccountEndpoint) == "" && strings.TrimSpace(chain.Endpoint) != "" {
			chain.AccountEndpoint = strings.TrimSpace(chain.Endpoint)
		}
		if strings.TrimSpace(chain.Endpoint) == "" && strings.TrimSpace(chain.AccountEndpoint) != "" {
			chain.Endpoint = strings.TrimSpace(chain.AccountEndpoint)
		}
		if chain.FinalityBlocks == 0 {
			if c.Proof.ConfirmationBlocks > 0 {
				chain.FinalityBlocks = uint64(c.Proof.ConfirmationBlocks)
			} else {
				chain.FinalityBlocks = 1
			}
		}
		if len(chain.ServiceStateContracts) == 0 && len(chain.ServiceStateGroups) > 0 {
			for _, addrs := range chain.ServiceStateGroups {
				chain.ServiceStateContracts = append(chain.ServiceStateContracts, addrs...)
			}
		}
		c.Chains[chainKey] = chain
	}

	appendNonEmpty(&c.Atom.WriteManifest, c.Atom.WriteOnlyManifest)
	appendNonEmpty(&c.Atom.ReadManifest, c.Atom.ReadWriteManifest)
	if len(c.Atom.JudgeKeys) == 0 && len(c.Atom.JudgePrivateKeys) > 0 {
		c.Atom.JudgeKeys = append([]string(nil), c.Atom.JudgePrivateKeys...)
	}
	if len(c.GPACT.SignerKeys) == 0 && len(c.GPACT.SignerPrivateKeys) > 0 {
		c.GPACT.SignerKeys = append([]string(nil), c.GPACT.SignerPrivateKeys...)
	}
	if c.GPACT.ExecutionMode == "" {
		c.GPACT.ExecutionMode = "serial"
	}
	if c.XSmart.ServiceID == "" {
		c.XSmart.ServiceID = "travel"
	}
	if c.XSmart.WASMLockNum == 0 {
		c.XSmart.WASMLockNum = 1
	}
	if c.XSmart.WASMTimeoutBlocks == 0 {
		c.XSmart.WASMTimeoutBlocks = 30
	}

	if c.Contracts.XSmart == nil {
		c.Contracts.XSmart = map[string]XSmartChainContracts{}
	}
	if c.Contracts.IntegrateX == nil {
		c.Contracts.IntegrateX = map[string]IntegrateXChainContracts{}
	}
	if c.Contracts.Atom == nil {
		c.Contracts.Atom = map[string]AtomChainContracts{}
	}
	if c.Contracts.GPACT == nil {
		c.Contracts.GPACT = map[string]GPACTChainContracts{}
	}

	for chainKey, chain := range c.Chains {
		if chain.ContractAddress != "" || chain.TravelDAppAddress != "" || len(chain.ServiceStateContracts) > 0 {
			entry := c.Contracts.IntegrateX[chainKey]
			appendNonEmpty(&entry.BridgeingContract, chain.ContractAddress)
			appendNonEmpty(&entry.TravelDApp, chain.TravelDAppAddress)
			if len(entry.StateContracts) == 0 && len(chain.ServiceStateContracts) > 0 {
				entry.StateContracts = append([]string(nil), chain.ServiceStateContracts...)
			}
			c.Contracts.IntegrateX[chainKey] = entry
		}

		if chain.AtomServiceAddress != "" || chain.AtomEntryAddress != "" || chain.AtomCommunityAddress != "" || chain.AtomRegistryAddress != "" || chain.AtomHotelAddress != "" || chain.AtomTrainAddress != "" || chain.AtomFlightAddress != "" || chain.AtomTaxiAddress != "" {
			entry := c.Contracts.Atom[chainKey]
			appendNonEmpty(&entry.AtomService, chain.AtomServiceAddress)
			appendNonEmpty(&entry.AtomTravelEntry, chain.AtomEntryAddress)
			appendNonEmpty(&entry.AtomRemoteReg, chain.AtomRegistryAddress)
			appendNonEmpty(&entry.AtomCommunity, chain.AtomCommunityAddress)
			appendNonEmpty(&entry.AtomHotel, chain.AtomHotelAddress)
			appendNonEmpty(&entry.AtomTrain, chain.AtomTrainAddress)
			appendNonEmpty(&entry.AtomFlight, chain.AtomFlightAddress)
			appendNonEmpty(&entry.AtomTaxi, chain.AtomTaxiAddress)
			c.Contracts.Atom[chainKey] = entry
		}

		if chain.GPACTControlAddress != "" || chain.GPACTAppAddress != "" || chain.GPACTSignerRegistry != "" {
			entry := c.Contracts.GPACT[chainKey]
			appendNonEmpty(&entry.GPACTControl, chain.GPACTControlAddress)
			appendNonEmpty(&entry.GPACTApp, chain.GPACTAppAddress)
			appendNonEmpty(&entry.GPACTSignerRegistry, chain.GPACTSignerRegistry)
			c.Contracts.GPACT[chainKey] = entry
		}
	}
}

func (c *Config) resolvePaths(baseDir string) {
	resolve := func(path string) string {
		if path == "" || filepath.IsAbs(path) {
			return path
		}
		return filepath.Clean(filepath.Join(baseDir, path))
	}
	c.Relayer.CheckpointFile = resolve(c.Relayer.CheckpointFile)
	c.Atom.WriteManifest = resolve(c.Atom.WriteManifest)
	c.Atom.ReadManifest = resolve(c.Atom.ReadManifest)
	c.GPACT.Manifest = resolve(c.GPACT.Manifest)
	c.XSmart.Manifest = resolve(c.XSmart.Manifest)
	for chainKey, chain := range c.Chains {
		chain.MetadataPath = resolve(chain.MetadataPath)
		chain.FabricUserCertPath = resolve(chain.FabricUserCertPath)
		chain.FabricUserKeyPath = resolve(chain.FabricUserKeyPath)
		chain.FabricTLSCertPath = resolve(chain.FabricTLSCertPath)
		c.Chains[chainKey] = chain
	}
}

func (c *Config) ProtocolName() protocolcommon.ProtocolName {
	return protocolcommon.NormalizeProtocol(c.Protocol)
}

func (c *Config) ContractRefs() []ContractRef {
	var refs []ContractRef
	refs = append(refs, c.xsmartContractRefs()...)
	refs = append(refs, c.integrateXContractRefs()...)
	refs = append(refs, c.atomContractRefs()...)
	refs = append(refs, c.gpactContractRefs()...)
	sort.Slice(refs, func(i, j int) bool {
		if refs[i].Protocol != refs[j].Protocol {
			return refs[i].Protocol < refs[j].Protocol
		}
		if refs[i].ChainKey != refs[j].ChainKey {
			return refs[i].ChainKey < refs[j].ChainKey
		}
		return refs[i].Name < refs[j].Name
	})
	return refs
}

func (c *Config) xsmartContractRefs() []ContractRef {
	var refs []ContractRef
	for chainKey, contracts := range c.Contracts.XSmart {
		chain := c.Chains[chainKey]
		refs = appendNonEmptyRef(refs, protocolcommon.ProtocolXSmart, chainKey, chain.ChainID, "xbridging_contract", contracts.XBridgingContract)
		refs = appendNonEmptyRef(refs, protocolcommon.ProtocolXSmart, chainKey, chain.ChainID, "ubtl_registry", contracts.UBTLRegistry)
		refs = appendNonEmptyRef(refs, protocolcommon.ProtocolXSmart, chainKey, chain.ChainID, "relayer_manager", contracts.RelayerManager)
		refs = appendNonEmptyRef(refs, protocolcommon.ProtocolXSmart, chainKey, chain.ChainID, "light_client", contracts.LightClient)
	}
	return refs
}

func (c *Config) integrateXContractRefs() []ContractRef {
	var refs []ContractRef
	for chainKey, contracts := range c.Contracts.IntegrateX {
		chain := c.Chains[chainKey]
		refs = appendNonEmptyRef(refs, protocolcommon.ProtocolIntegrateX, chainKey, chain.ChainID, "contract_address", contracts.BridgeingContract)
		refs = appendNonEmptyRef(refs, protocolcommon.ProtocolIntegrateX, chainKey, chain.ChainID, "travel_dapp_address", contracts.TravelDApp)
		refs = appendNonEmptyRef(refs, protocolcommon.ProtocolIntegrateX, chainKey, chain.ChainID, "relayerManager", contracts.RelayerManager)
		for idx, addr := range contracts.StateContracts {
			refs = appendNonEmptyRef(refs, protocolcommon.ProtocolIntegrateX, chainKey, chain.ChainID, fmt.Sprintf("service_state_contract_%d", idx), addr)
		}
	}
	return refs
}

func (c *Config) atomContractRefs() []ContractRef {
	var refs []ContractRef
	for chainKey, contracts := range c.Contracts.Atom {
		chain := c.Chains[chainKey]
		refs = appendNonEmptyRef(refs, protocolcommon.ProtocolAtom, chainKey, chain.ChainID, "atom_service_address", contracts.AtomService)
		refs = appendNonEmptyRef(refs, protocolcommon.ProtocolAtom, chainKey, chain.ChainID, "atom_entry_address", contracts.AtomTravelEntry)
		refs = appendNonEmptyRef(refs, protocolcommon.ProtocolAtom, chainKey, chain.ChainID, "atom_registry_address", contracts.AtomRemoteReg)
		refs = appendNonEmptyRef(refs, protocolcommon.ProtocolAtom, chainKey, chain.ChainID, "atom_community_address", contracts.AtomCommunity)
		refs = appendNonEmptyRef(refs, protocolcommon.ProtocolAtom, chainKey, chain.ChainID, "atom_hotel_address", contracts.AtomHotel)
		refs = appendNonEmptyRef(refs, protocolcommon.ProtocolAtom, chainKey, chain.ChainID, "atom_train_address", contracts.AtomTrain)
		refs = appendNonEmptyRef(refs, protocolcommon.ProtocolAtom, chainKey, chain.ChainID, "atom_flight_address", contracts.AtomFlight)
		refs = appendNonEmptyRef(refs, protocolcommon.ProtocolAtom, chainKey, chain.ChainID, "atom_taxi_address", contracts.AtomTaxi)
	}
	return refs
}

func (c *Config) gpactContractRefs() []ContractRef {
	var refs []ContractRef
	for chainKey, contracts := range c.Contracts.GPACT {
		chain := c.Chains[chainKey]
		refs = appendNonEmptyRef(refs, protocolcommon.ProtocolGPACT, chainKey, chain.ChainID, "gpact_control_address", contracts.GPACTControl)
		refs = appendNonEmptyRef(refs, protocolcommon.ProtocolGPACT, chainKey, chain.ChainID, "gpact_app_address", contracts.GPACTApp)
		refs = appendNonEmptyRef(refs, protocolcommon.ProtocolGPACT, chainKey, chain.ChainID, "gpact_signer_registry_address", contracts.GPACTSignerRegistry)
	}
	return refs
}

func appendNonEmpty(dst *string, value string) {
	if *dst == "" && strings.TrimSpace(value) != "" {
		*dst = strings.TrimSpace(value)
	}
}

func appendNonEmptyRef(dst []ContractRef, protocol protocolcommon.ProtocolName, chainKey string, chainID uint64, name, address string) []ContractRef {
	if strings.TrimSpace(address) == "" {
		return dst
	}
	return append(dst, ContractRef{
		Protocol: protocol,
		ChainKey: chainKey,
		ChainID:  chainID,
		Name:     name,
		Address:  strings.TrimSpace(address),
	})
}
