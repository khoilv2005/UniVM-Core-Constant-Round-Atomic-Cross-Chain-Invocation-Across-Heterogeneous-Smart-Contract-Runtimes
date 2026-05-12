package event

import (
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/xsmart/relayer/internal/config"
	protocolcommon "github.com/xsmart/relayer/internal/protocol/common"
)

type WatchSpec struct {
	Protocol     protocolcommon.ProtocolName
	ChainKey     string
	ChainID      uint64
	Address      common.Address
	ContractKind string
}

type Registry struct {
	protocol protocolcommon.ProtocolName
	events   map[common.Hash]abi.Event
}

func NewRegistry(protocol protocolcommon.ProtocolName) *Registry {
	r := &Registry{
		protocol: protocol,
		events:   map[common.Hash]abi.Event{},
	}
	var source abi.ABI
	switch protocol {
	case protocolcommon.ProtocolXSmart:
		source = xsmartABI
	case protocolcommon.ProtocolIntegrateX:
		source = integratexABI
	case protocolcommon.ProtocolAtom:
		source = atomABI
	case protocolcommon.ProtocolGPACT:
		source = gpactABI
	default:
		return r
	}
	for _, ev := range source.Events {
		r.events[ev.ID] = ev
	}
	return r
}

func (r *Registry) AllTopics() [][]common.Hash {
	topics := make([]common.Hash, 0, len(r.events))
	for topic := range r.events {
		topics = append(topics, topic)
	}
	return [][]common.Hash{topics}
}

func (r *Registry) Decode(spec WatchSpec, raw types.Log) (protocolcommon.NormalizedEvent, error) {
	if len(raw.Topics) == 0 {
		return protocolcommon.NormalizedEvent{}, fmt.Errorf("log missing topics")
	}
	eventDef, ok := r.events[raw.Topics[0]]
	if !ok {
		return protocolcommon.NormalizedEvent{}, fmt.Errorf("unregistered topic %s", raw.Topics[0].Hex())
	}

	args := map[string]any{}
	if len(raw.Topics) > 1 {
		if err := abi.ParseTopicsIntoMap(args, indexedInputs(eventDef.Inputs), raw.Topics[1:]); err != nil {
			return protocolcommon.NormalizedEvent{}, err
		}
	}
	if len(raw.Data) > 0 {
		if err := eventDef.Inputs.NonIndexed().UnpackIntoMap(args, raw.Data); err != nil {
			return protocolcommon.NormalizedEvent{}, err
		}
	}

	return protocolcommon.NormalizedEvent{
		Protocol:     spec.Protocol,
		ChainName:    spec.ChainKey,
		ChainID:      spec.ChainID,
		ContractKind: spec.ContractKind,
		ContractAddr: raw.Address,
		Name:         eventDef.Name,
		TxID:         inferTxID(args, raw.TxHash),
		BlockNumber:  raw.BlockNumber,
		TxHash:       raw.TxHash,
		LogIndex:     uint(raw.Index),
		Topic0:       raw.Topics[0],
		Args:         args,
		RawLog:       raw,
		ReceivedAt:   time.Now().UTC(),
	}, nil
}

func BuildWatchSpecs(cfg *config.Config, registry *Registry) []WatchSpec {
	var specs []WatchSpec
	for _, ref := range cfg.ContractRefs() {
		if ref.Protocol != cfg.ProtocolName() {
			continue
		}
		if !common.IsHexAddress(ref.Address) {
			continue
		}
		specs = append(specs, WatchSpec{
			Protocol:     ref.Protocol,
			ChainKey:     ref.ChainKey,
			ChainID:      ref.ChainID,
			Address:      common.HexToAddress(ref.Address),
			ContractKind: canonicalContractKind(ref.Protocol, ref.ChainKey, ref.Name),
		})
	}
	return specs
}

func canonicalContractKind(protocol protocolcommon.ProtocolName, chainKey, refName string) string {
	switch protocol {
	case protocolcommon.ProtocolXSmart:
		switch refName {
		case "xbridging_contract":
			return "xBridgingContract"
		case "ubtl_registry":
			return "ubtlRegistry"
		case "relayer_manager":
			return "relayerManager"
		case "light_client":
			return "lightClient"
		}
	case protocolcommon.ProtocolIntegrateX:
		switch {
		case refName == "contract_address":
			return "bridgingContract"
		case refName == "travel_dapp_address":
			return "travelDApp"
		case refName == "relayerManager":
			return "relayerManager"
		case strings.HasPrefix(refName, "service_state_contract_"):
			return "stateContract"
		}
	case protocolcommon.ProtocolAtom:
		switch refName {
		case "atom_service_address":
			return "atomService"
		case "atom_entry_address":
			return "atomTravelEntry"
		case "atom_registry_address":
			return "atomRemoteRegistry"
		case "atom_community_address":
			return "atomCommunity"
		case "atom_hotel_address":
			return "atomHotel"
		case "atom_train_address":
			return "atomTrain"
		case "atom_flight_address":
			return "atomFlight"
		case "atom_taxi_address":
			return "atomTaxi"
		}
	case protocolcommon.ProtocolGPACT:
		switch refName {
		case "gpact_control_address":
			return "gpactControl"
		case "gpact_app_address":
			if chainKey == "bc1" {
				return "gpactTravelRoot"
			}
			return "gpactLockableApp"
		case "gpact_signer_registry_address":
			return "gpactSignerRegistry"
		}
	}
	return refName
}

func inferTxID(args map[string]any, txHash common.Hash) string {
	for _, key := range []string{"crossChainTxId", "crosschainTxId", "invokeId"} {
		value, ok := args[key]
		if !ok {
			continue
		}
		switch v := value.(type) {
		case *big.Int:
			return v.String()
		case common.Hash:
			return v.Hex()
		case [32]byte:
			return common.BytesToHash(v[:]).Hex()
		case []byte:
			return common.BytesToHash(v).Hex()
		case string:
			return v
		}
	}
	return txHash.Hex()
}

func indexedInputs(inputs abi.Arguments) abi.Arguments {
	var out abi.Arguments
	for _, input := range inputs {
		if input.Indexed {
			out = append(out, input)
		}
	}
	return out
}
