package main

import (
	"context"
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/urfave/cli/v2"
	"github.com/xsmart/relayer/internal/config"
	"github.com/xsmart/relayer/internal/event"
	atomprotocol "github.com/xsmart/relayer/internal/protocol/atom"
	protocolcommon "github.com/xsmart/relayer/internal/protocol/common"
	gpactprotocol "github.com/xsmart/relayer/internal/protocol/gpact"
	integratexprotocol "github.com/xsmart/relayer/internal/protocol/integratex"
	xsmartprotocol "github.com/xsmart/relayer/internal/protocol/xsmart"
	"github.com/xsmart/relayer/internal/relay"
	"github.com/xsmart/relayer/internal/transport"
)

const version = "0.1.0"

func main() {
	app := &cli.App{
		Name:  "relayer",
		Usage: "Unified relayer for XSmart, IntegrateX, ATOM, and GPACT",
		Commands: []*cli.Command{
			{
				Name:   "start",
				Usage:  "Start relayer runtime",
				Action: startRelayer,
				Flags: []cli.Flag{
					&cli.StringFlag{Name: "config", Required: true},
				},
			},
			{
				Name:   "selfcheck",
				Usage:  "Validate config and live contracts",
				Action: runSelfcheck,
				Flags: []cli.Flag{
					&cli.StringFlag{Name: "config", Required: true},
				},
			},
			{
				Name:   "fabric-evaluate",
				Usage:  "Evaluate a Fabric Gateway transaction using relayer config",
				Action: runFabricEvaluate,
				Flags: []cli.Flag{
					&cli.StringFlag{Name: "config", Required: true},
					&cli.StringFlag{Name: "chain", Required: true},
					&cli.StringFlag{Name: "endpoint", Required: true},
					&cli.StringFlag{Name: "method", Required: true},
					&cli.StringSliceFlag{Name: "args"},
				},
			},
			{
				Name:   "fabric-submit",
				Usage:  "Submit a Fabric Gateway transaction using relayer config",
				Action: runFabricSubmit,
				Flags: []cli.Flag{
					&cli.StringFlag{Name: "config", Required: true},
					&cli.StringFlag{Name: "chain", Required: true},
					&cli.StringFlag{Name: "endpoint", Required: true},
					&cli.StringFlag{Name: "method", Required: true},
					&cli.StringSliceFlag{Name: "args"},
				},
			},
			{
				Name: "version",
				Action: func(ctx *cli.Context) error {
					fmt.Println(version)
					return nil
				},
			},
		},
	}

	if err := app.Run(os.Args); err != nil {
		log.Fatal(err)
	}
}

func startRelayer(c *cli.Context) error {
	cfg, err := config.Load(c.String("config"))
	if err != nil {
		return err
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	key, err := parsePrivateKey(cfg.Relayer.PrivateKey)
	if err != nil {
		return err
	}
	clients, err := connectChains(ctx, cfg, key)
	if err != nil {
		return err
	}
	defer func() {
		for _, client := range clients {
			client.Close()
		}
	}()

	handler, err := newHandler(cfg, clients)
	if err != nil {
		return err
	}

	registry := event.NewRegistry(cfg.ProtocolName())
	listener := event.NewListener(registry)
	marker := event.NewLogMarker()
	store, err := relay.NewCheckpointStore(cfg.Relayer.CheckpointFile)
	if err != nil {
		return err
	}

	signerPool, extras, err := buildSignerClientPool(ctx, cfg, clients)
	if err != nil {
		return err
	}
	defer closeSignerPool(signerPool, clients, extras)

	workers := effectiveSchedulerWorkers(cfg)
	scheduler := relay.NewScheduler(workers, time.Duration(cfg.Proof.RetryDelayMs)*time.Millisecond, signerPool, store, marker)
	scheduler.Start(ctx)

	sink := make(chan protocolcommon.NormalizedEvent, 256)
	if err := listener.Start(ctx, cfg, clients, sink); err != nil {
		return err
	}
	startEndpointSubscriptions(ctx, cfg, signerPool, sink)

	for {
		select {
		case <-ctx.Done():
			return nil
		case ev := <-sink:
			marker.EmitEvent(ev)
			actions, err := handler.Handle(ctx, ev)
			if err != nil {
				log.Printf("handle %s failed: %v", ev.Name, err)
				continue
			}
			if len(actions) == 0 {
				continue
			}
			if err := scheduler.Enqueue(actions...); err != nil {
				log.Printf("enqueue %s failed: %v", ev.Name, err)
			}
		}
	}
}

func runSelfcheck(c *cli.Context) error {
	cfg, err := config.Load(c.String("config"))
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	key, err := parsePrivateKey(cfg.Relayer.PrivateKey)
	if err != nil {
		return err
	}
	clients, err := connectChains(ctx, cfg, key)
	if err != nil {
		return err
	}
	defer func() {
		for _, client := range clients {
			client.Close()
		}
	}()

	for _, ref := range cfg.ContractRefs() {
		client := clients[ref.ChainKey]
		if client == nil {
			return fmt.Errorf("missing client for chain %s", ref.ChainKey)
		}
		code, err := client.HTTP.CodeAt(ctx, common.HexToAddress(ref.Address), nil)
		if err != nil {
			return fmt.Errorf("%s/%s code check: %w", ref.ChainKey, ref.Name, err)
		}
		if len(code) == 0 {
			return fmt.Errorf("%s/%s has no bytecode at %s", ref.ChainKey, ref.Name, ref.Address)
		}
	}

	switch cfg.ProtocolName() {
	case protocolcommon.ProtocolXSmart:
		if err := selfcheckXSmart(ctx, cfg, clients); err != nil {
			return err
		}
	case protocolcommon.ProtocolIntegrateX:
		if err := selfcheckIntegrateX(ctx, cfg, clients); err != nil {
			return err
		}
	case protocolcommon.ProtocolAtom:
		if err := selfcheckAtom(ctx, cfg, clients); err != nil {
			return err
		}
	case protocolcommon.ProtocolGPACT:
		if err := selfcheckGPACT(ctx, cfg, clients); err != nil {
			return err
		}
	}

	fmt.Println("selfcheck: ok")
	return nil
}

func runFabricEvaluate(c *cli.Context) error {
	cfg, err := config.Load(c.String("config"))
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	chainKey := strings.TrimSpace(c.String("chain"))
	chain, ok := cfg.Chains[chainKey]
	if !ok {
		return fmt.Errorf("unknown chain %s", chainKey)
	}
	client := transport.NewFabricClient(chainKey, chain.ChainID, firstNonEmpty(chain.RPCURL, chain.HTTPURL), fabricGatewayConfig(chain))
	defer client.Close()
	raw, err := client.GatewayEvaluate(ctx, strings.TrimSpace(c.String("endpoint")), strings.TrimSpace(c.String("method")), c.StringSlice("args")...)
	if err != nil {
		return err
	}
	return emitFabricResult(map[string]any{
		"ok":     true,
		"result": string(raw),
		"base64": base64.StdEncoding.EncodeToString(raw),
	})
}

func runFabricSubmit(c *cli.Context) error {
	cfg, err := config.Load(c.String("config"))
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	chainKey := strings.TrimSpace(c.String("chain"))
	chain, ok := cfg.Chains[chainKey]
	if !ok {
		return fmt.Errorf("unknown chain %s", chainKey)
	}
	client := transport.NewFabricClient(chainKey, chain.ChainID, firstNonEmpty(chain.RPCURL, chain.HTTPURL), fabricGatewayConfig(chain))
	defer client.Close()
	result, err := client.GatewaySubmit(ctx, strings.TrimSpace(c.String("endpoint")), strings.TrimSpace(c.String("method")), c.StringSlice("args")...)
	if err != nil {
		return err
	}
	return emitFabricResult(map[string]any{
		"ok":             true,
		"transaction_id": result.TransactionID,
		"block_number":   result.BlockNumber,
		"result":         string(result.Result),
		"base64":         base64.StdEncoding.EncodeToString(result.Result),
	})
}

func emitFabricResult(value map[string]any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	fmt.Println(string(raw))
	return nil
}

func startEndpointSubscriptions(ctx context.Context, cfg *config.Config, pool map[uint64]map[string]transport.Transport, sink chan<- protocolcommon.NormalizedEvent) {
	for chainKey, chain := range cfg.Chains {
		if strings.EqualFold(chain.VM, "evm") {
			continue
		}
		defaultPool := pool[chain.ChainID]
		if defaultPool == nil {
			continue
		}
		client := defaultPool[""]
		if client == nil {
			continue
		}
		rawSink := make(chan transport.NormalizedEvent, 128)
		if err := client.Subscribe(ctx, transport.SubscribeFilter{
			ChainName: chainKey,
			ChainID:   chain.ChainID,
		}, rawSink); err != nil {
			log.Printf("subscribe %s failed: %v", chainKey, err)
			continue
		}
		go func(chainKey string, chainID uint64, rawSink <-chan transport.NormalizedEvent) {
			for {
				select {
				case <-ctx.Done():
					return
				case raw, ok := <-rawSink:
					if !ok {
						return
					}
					if strings.TrimSpace(raw.Name) == "" {
						continue
					}
					ev := protocolcommon.NormalizedEvent{
						Protocol:     cfg.ProtocolName(),
						ChainName:    chainKey,
						ChainID:      chainID,
						ContractKind: "endpoint",
						ContractAddr: raw.Contract,
						Name:         raw.Name,
						TxID:         inferEndpointTxID(raw.Args, raw.TxHash),
						BlockNumber:  raw.BlockNumber,
						TxHash:       raw.TxHash,
						LogIndex:     raw.LogIndex,
						Topic0:       raw.Topic0,
						Args:         raw.Args,
						RawLog:       raw.RawLog,
						ReceivedAt:   raw.ReceivedAt,
					}
					select {
					case sink <- ev:
					case <-ctx.Done():
						return
					}
				}
			}
		}(chainKey, chain.ChainID, rawSink)
	}
}

func inferEndpointTxID(args map[string]any, fallback common.Hash) string {
	for _, key := range []string{"crossChainTxId", "crosschainTxId", "invokeId"} {
		value, ok := args[key]
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case *big.Int:
			return typed.String()
		case common.Hash:
			return typed.Hex()
		case [32]byte:
			return common.BytesToHash(typed[:]).Hex()
		case []byte:
			return common.BytesToHash(typed).Hex()
		case string:
			if strings.TrimSpace(typed) != "" {
				return strings.TrimSpace(typed)
			}
		}
	}
	return fallback.Hex()
}

func connectChains(ctx context.Context, cfg *config.Config, key *ecdsa.PrivateKey) (map[string]*transport.EVMClient, error) {
	out := make(map[string]*transport.EVMClient, len(cfg.Chains))
	for chainKey, chain := range cfg.Chains {
		if !strings.EqualFold(chain.VM, "evm") {
			continue
		}
		httpURL := chain.HTTPURL
		if httpURL == "" {
			httpURL = chain.RPCURL
		}
		wsURL := chain.WSURL
		if wsURL == "" && strings.HasPrefix(strings.ToLower(chain.RPCURL), "ws") {
			wsURL = chain.RPCURL
		}
		client, err := transport.NewEVMClient(ctx, chainKey, httpURL, wsURL, chain.ChainID, key, chain.GasLimit, chain.GasPriceGwei, chain.FinalityBlocks)
		if err != nil {
			return nil, err
		}
		out[chainKey] = client
	}
	return out, nil
}

func buildSignerClientPool(ctx context.Context, cfg *config.Config, base map[string]*transport.EVMClient) (map[uint64]map[string]transport.Transport, []transport.Transport, error) {
	pool := map[uint64]map[string]transport.Transport{}
	var extras []transport.Transport
	for chainKey, chain := range cfg.Chains {
		if pool[chain.ChainID] == nil {
			pool[chain.ChainID] = map[string]transport.Transport{}
		}
		client, owned, err := transportForChain(chainKey, chain, cfg.Proof, base)
		if err != nil {
			return nil, nil, err
		}
		if client != nil {
			pool[chain.ChainID][""] = client
		}
		if owned != nil {
			extras = append(extras, owned)
		}
	}
	for chainKey, chain := range cfg.Chains {
		if pool[chain.ChainID] == nil {
			pool[chain.ChainID] = map[string]transport.Transport{}
		}
		if _, exists := pool[chain.ChainID][""]; exists {
			continue
		}
		client, owned, err := transportForChain(chainKey, chain, cfg.Proof, base)
		if err != nil {
			return nil, nil, err
		}
		if client != nil {
			pool[chain.ChainID][""] = client
		}
		if owned != nil {
			extras = append(extras, owned)
		}
	}
	if cfg.ProtocolName() != protocolcommon.ProtocolAtom {
		return pool, extras, nil
	}

	for _, rawKey := range cfg.Atom.JudgeKeys {
		key, err := parsePrivateKey(rawKey)
		if err != nil {
			return nil, nil, err
		}
		addr := strings.ToLower(crypto.PubkeyToAddress(key.PublicKey).Hex())
		for chainKey, chain := range cfg.Chains {
			if !strings.EqualFold(chain.VM, "evm") && strings.TrimSpace(chain.VM) != "" {
				continue
			}
			httpURL := chain.HTTPURL
			if httpURL == "" {
				httpURL = chain.RPCURL
			}
			wsURL := chain.WSURL
			if wsURL == "" && strings.HasPrefix(strings.ToLower(chain.RPCURL), "ws") {
				wsURL = chain.RPCURL
			}
			client, err := transport.NewEVMClient(ctx, chainKey, httpURL, wsURL, chain.ChainID, key, chain.GasLimit, chain.GasPriceGwei, chain.FinalityBlocks)
			if err != nil {
				return nil, nil, err
			}
			pool[chain.ChainID][addr] = client
			extras = append(extras, client)
		}
	}
	return pool, extras, nil
}

func closeSignerPool(pool map[uint64]map[string]transport.Transport, base map[string]*transport.EVMClient, extras []transport.Transport) {
	for _, client := range extras {
		client.Close()
	}
}

func transportForChain(chainKey string, chain config.ChainConfig, proof config.ProofConfig, base map[string]*transport.EVMClient) (transport.Transport, transport.Transport, error) {
	if strings.EqualFold(chain.VM, "evm") || strings.TrimSpace(chain.VM) == "" {
		if client := base[chainKey]; client != nil {
			return client, nil, nil
		}
		return nil, nil, fmt.Errorf("missing evm client for chain %s", chainKey)
	}
	if strings.EqualFold(chain.VM, "wasm") {
		client := transport.NewWASMClient(
			chainKey,
			chain.ChainID,
			firstNonEmpty(chain.RPCURL, chain.HTTPURL),
			chain.WSURL,
			chain.MetadataPath,
			chain.EffectiveEndpoint(),
			chain.SubmitterURI,
			chain.FinalityBlocks,
		)
		client.SetEvidenceMode(proof.Mode, proof.RequireNonEVMProofs)
		return client, client, nil
	}
	if strings.EqualFold(chain.VM, "fabric") {
		client := transport.NewFabricClient(chainKey, chain.ChainID, firstNonEmpty(chain.RPCURL, chain.HTTPURL), fabricGatewayConfig(chain))
		client.SetEvidenceMode(proof.Mode, proof.RequireNonEVMProofs)
		return client, client, nil
	}
	return nil, nil, fmt.Errorf("unsupported chain vm %s for %s", chain.VM, chainKey)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func fabricGatewayConfig(chain config.ChainConfig) *transport.FabricGatewayConfig {
	if strings.TrimSpace(chain.FabricGatewayEndpoint) == "" {
		return nil
	}
	return &transport.FabricGatewayConfig{
		Endpoint:  strings.TrimSpace(chain.FabricGatewayEndpoint),
		Channel:   strings.TrimSpace(chain.FabricChannel),
		Chaincode: strings.TrimSpace(chain.FabricChaincode),
		MSPID:     strings.TrimSpace(chain.FabricMSPID),
		UserCert:  strings.TrimSpace(chain.FabricUserCertPath),
		UserKey:   strings.TrimSpace(chain.FabricUserKeyPath),
		TLSCert:   strings.TrimSpace(chain.FabricTLSCertPath),
		PeerName:  strings.TrimSpace(chain.FabricPeerName),
	}
}

func newHandler(cfg *config.Config, clients map[string]*transport.EVMClient) (protocolcommon.Handler, error) {
	switch cfg.ProtocolName() {
	case protocolcommon.ProtocolXSmart:
		return xsmartprotocol.NewExecutor(cfg, clients["bc1"])
	case protocolcommon.ProtocolIntegrateX:
		return integratexprotocol.NewExecutor(cfg, clients["bc1"])
	case protocolcommon.ProtocolAtom:
		server, err := atomprotocol.NewServer(cfg)
		if err != nil {
			return nil, err
		}
		judge, err := atomprotocol.NewJudge(cfg, clients["bc1"])
		if err != nil {
			return nil, err
		}
		return protocolcommon.NewMultiHandler(protocolcommon.ProtocolAtom, server, judge), nil
	case protocolcommon.ProtocolGPACT:
		return gpactprotocol.NewExecutor(cfg, clients)
	default:
		return nil, fmt.Errorf("unsupported protocol %s", cfg.Protocol)
	}
}

func effectiveSchedulerWorkers(cfg *config.Config) int {
	workers := cfg.Relayer.Workers
	if workers <= 0 {
		workers = 1
	}
	if cfg.ProtocolName() == protocolcommon.ProtocolGPACT && strings.EqualFold(cfg.GPACT.ExecutionMode, "serial") {
		return 1
	}
	return workers
}

func parsePrivateKey(raw string) (*ecdsa.PrivateKey, error) {
	keyHex := strings.TrimPrefix(strings.TrimSpace(raw), "0x")
	bytes, err := hex.DecodeString(keyHex)
	if err != nil {
		return nil, err
	}
	return crypto.ToECDSA(bytes)
}

var (
	relayerManagerABI = mustABI(`[{"inputs":[{"internalType":"address","name":"relayer","type":"address"}],"name":"isRelayerActive","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"}]`)
	atomCommunityABI  = mustABI(`[
      {"inputs":[{"internalType":"address","name":"server","type":"address"}],"name":"activeServers","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},
      {"inputs":[{"internalType":"address","name":"judge","type":"address"}],"name":"activeJudges","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"}
    ]`)
	gpactRegistryABI = mustABI(`[
      {"inputs":[{"internalType":"address","name":"signer","type":"address"}],"name":"activeSigners","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},
      {"inputs":[],"name":"quorum","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
    ]`)
)

func selfcheckXSmart(ctx context.Context, cfg *config.Config, clients map[string]*transport.EVMClient) error {
	if strings.TrimSpace(cfg.XSmart.Manifest) == "" {
		return fmt.Errorf("xsmart manifest is not configured")
	}
	manifest, err := xsmartprotocol.LoadManifest(cfg.XSmart.Manifest)
	if err != nil {
		return fmt.Errorf("load xsmart manifest: %w", err)
	}
	if err := manifest.Validate(); err != nil {
		return fmt.Errorf("validate xsmart manifest: %w", err)
	}
	chainKey := "bc1"
	addr := cfg.Contracts.XSmart[chainKey].RelayerManager
	if addr == "" || !common.IsHexAddress(addr) {
		return fmt.Errorf("xsmart relayer manager missing on bc1")
	}
	client := clients[chainKey]
	if client == nil {
		return fmt.Errorf("missing evm client for xsmart root chain %s", chainKey)
	}
	call, err := relayerManagerABI.Pack("isRelayerActive", client.From)
	if err != nil {
		return err
	}
	active, err := callBool(ctx, client, common.HexToAddress(addr), relayerManagerABI, "isRelayerActive", call)
	if err != nil {
		return err
	}
	if !active {
		return fmt.Errorf("xsmart relayer %s is not active in relayer manager", client.From.Hex())
	}

	if wasmChainKey := manifest.EffectiveWASMChain(""); wasmChainKey != "" {
		wasmChain, ok := cfg.Chains[wasmChainKey]
		if !ok {
			return fmt.Errorf("xsmart manifest references unknown wasm chain %s", wasmChainKey)
		}
		if !strings.EqualFold(wasmChain.VM, "wasm") {
			return fmt.Errorf("xsmart manifest chain %s is configured as %s, expected wasm", wasmChainKey, wasmChain.VM)
		}
		wasmClient := transport.NewWASMClient(
			wasmChainKey,
			wasmChain.ChainID,
			firstNonEmpty(wasmChain.RPCURL, wasmChain.HTTPURL),
			wasmChain.WSURL,
			wasmChain.MetadataPath,
			wasmChain.EffectiveEndpoint(),
			wasmChain.SubmitterURI,
			wasmChain.FinalityBlocks,
		)
		best, err := wasmClient.BestBlockNumber(ctx)
		if err != nil {
			return fmt.Errorf("xsmart wasm chain %s healthcheck failed: %w", wasmChainKey, err)
		}
		if strings.TrimSpace(best) == "" {
			return fmt.Errorf("xsmart wasm chain %s returned empty best block", wasmChainKey)
		}
		fmt.Printf("xsmart: manifest ok, wasm chain %s best block %s\n", wasmChainKey, best)
	}
	if fabricChainKey := manifest.EffectiveFabricChain(""); fabricChainKey != "" {
		fabricChain, ok := cfg.Chains[fabricChainKey]
		if !ok {
			return fmt.Errorf("xsmart manifest references unknown fabric chain %s", fabricChainKey)
		}
		if !strings.EqualFold(fabricChain.VM, "fabric") {
			return fmt.Errorf("xsmart manifest chain %s is configured as %s, expected fabric", fabricChainKey, fabricChain.VM)
		}
		fabricClient := transport.NewFabricClient(
			fabricChainKey,
			fabricChain.ChainID,
			firstNonEmpty(fabricChain.RPCURL, fabricChain.HTTPURL),
			fabricGatewayConfig(fabricChain),
		)
		best, err := fabricClient.BestBlockNumber(ctx)
		if err != nil {
			return fmt.Errorf("xsmart fabric chain %s healthcheck failed: %w", fabricChainKey, err)
		}
		if strings.TrimSpace(best) == "" {
			return fmt.Errorf("xsmart fabric chain %s returned empty best block", fabricChainKey)
		}
		fmt.Printf("xsmart: manifest ok, fabric chain %s best block %s\n", fabricChainKey, best)
	}
	return nil
}

func selfcheckIntegrateX(ctx context.Context, cfg *config.Config, clients map[string]*transport.EVMClient) error {
	chainKey := "bc1"
	addr := cfg.Contracts.IntegrateX[chainKey].RelayerManager
	if addr == "" || !common.IsHexAddress(addr) {
		return nil
	}
	client := clients[chainKey]
	call, err := relayerManagerABI.Pack("isRelayerActive", client.From)
	if err != nil {
		return err
	}
	active, err := callBool(ctx, client, common.HexToAddress(addr), relayerManagerABI, "isRelayerActive", call)
	if err != nil {
		return err
	}
	if !active {
		return fmt.Errorf("integratex relayer %s is not active in relayer manager", client.From.Hex())
	}
	return nil
}

func selfcheckAtom(ctx context.Context, cfg *config.Config, clients map[string]*transport.EVMClient) error {
	communityAddr := cfg.Contracts.Atom["bc1"].AtomCommunity
	if communityAddr == "" || !common.IsHexAddress(communityAddr) {
		communityAddr = cfg.Chains["bc1"].AtomCommunityAddress
	}
	if !common.IsHexAddress(communityAddr) {
		return nil
	}
	client := clients["bc1"]
	serverCall, err := atomCommunityABI.Pack("activeServers", client.From)
	if err != nil {
		return err
	}
	serverActive, err := callBool(ctx, client, common.HexToAddress(communityAddr), atomCommunityABI, "activeServers", serverCall)
	if err != nil {
		return err
	}
	if !serverActive {
		return fmt.Errorf("atom server %s is not active", client.From.Hex())
	}
	for _, raw := range cfg.Atom.JudgeKeys {
		key, err := parsePrivateKey(raw)
		if err != nil {
			return err
		}
		judgeAddr := crypto.PubkeyToAddress(key.PublicKey)
		call, err := atomCommunityABI.Pack("activeJudges", judgeAddr)
		if err != nil {
			return err
		}
		active, err := callBool(ctx, client, common.HexToAddress(communityAddr), atomCommunityABI, "activeJudges", call)
		if err != nil {
			return err
		}
		if !active {
			return fmt.Errorf("atom judge %s is not active", judgeAddr.Hex())
		}
	}
	return nil
}

func selfcheckGPACT(ctx context.Context, cfg *config.Config, clients map[string]*transport.EVMClient) error {
	registryAddr := cfg.Contracts.GPACT["bc1"].GPACTSignerRegistry
	if registryAddr == "" || !common.IsHexAddress(registryAddr) {
		registryAddr = cfg.Chains["bc1"].GPACTSignerRegistry
	}
	if !common.IsHexAddress(registryAddr) {
		return nil
	}
	client := clients["bc1"]
	quorumCall, err := gpactRegistryABI.Pack("quorum")
	if err != nil {
		return err
	}
	quorum, err := callUint64(ctx, client, common.HexToAddress(registryAddr), gpactRegistryABI, "quorum", quorumCall)
	if err != nil {
		return err
	}
	if quorum == 0 {
		return fmt.Errorf("gpact quorum is zero")
	}
	for _, raw := range cfg.GPACT.SignerKeys {
		key, err := parsePrivateKey(raw)
		if err != nil {
			return err
		}
		addr := crypto.PubkeyToAddress(key.PublicKey)
		call, err := gpactRegistryABI.Pack("activeSigners", addr)
		if err != nil {
			return err
		}
		active, err := callBool(ctx, client, common.HexToAddress(registryAddr), gpactRegistryABI, "activeSigners", call)
		if err != nil {
			return err
		}
		if !active {
			return fmt.Errorf("gpact signer %s is not active", addr.Hex())
		}
	}
	return nil
}

func callBool(ctx context.Context, client *transport.EVMClient, to common.Address, parsed abi.ABI, method string, calldata []byte) (bool, error) {
	raw, err := client.Call(ctx, to, calldata)
	if err != nil {
		return false, err
	}
	values, err := parsed.Unpack(method, raw)
	if err != nil {
		return false, err
	}
	if len(values) != 1 {
		return false, fmt.Errorf("%s returned %d outputs", method, len(values))
	}
	value, ok := values[0].(bool)
	if !ok {
		return false, fmt.Errorf("%s output is not bool", method)
	}
	return value, nil
}

func callUint64(ctx context.Context, client *transport.EVMClient, to common.Address, parsed abi.ABI, method string, calldata []byte) (uint64, error) {
	raw, err := client.Call(ctx, to, calldata)
	if err != nil {
		return 0, err
	}
	values, err := parsed.Unpack(method, raw)
	if err != nil {
		return 0, err
	}
	if len(values) != 1 {
		return 0, fmt.Errorf("%s returned %d outputs", method, len(values))
	}
	switch v := values[0].(type) {
	case *big.Int:
		return v.Uint64(), nil
	case uint64:
		return v, nil
	default:
		return 0, fmt.Errorf("%s output is %T, not uint64", method, v)
	}
}

func mustABI(raw string) abi.ABI {
	parsed, err := abi.JSON(strings.NewReader(raw))
	if err != nil {
		panic(err)
	}
	return parsed
}

var _ = types.ReceiptStatusSuccessful
