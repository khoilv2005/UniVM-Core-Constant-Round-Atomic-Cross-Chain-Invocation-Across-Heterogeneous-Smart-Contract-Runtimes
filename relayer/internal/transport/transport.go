package transport

import (
	"context"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

type SubscribeFilter struct {
	ChainName string
	ChainID   uint64
	Addresses []common.Address
	Topics    [][]common.Hash
	FromBlock *big.Int
}

type Receipt struct {
	TxHash      common.Hash
	BlockNumber uint64
	GasUsed     uint64
	Success     bool
	Raw         *types.Receipt
}

type NormalizedEvent struct {
	ChainName   string
	ChainID     uint64
	BlockNumber uint64
	TxHash      common.Hash
	LogIndex    uint
	Contract    common.Address
	ContractRef string
	Topic0      common.Hash
	Name        string
	Args        map[string]any
	RawLog      types.Log
	ReceivedAt  time.Time
}

type Transport interface {
	Send(ctx context.Context, to common.Address, calldata []byte) (common.Hash, error)
	WaitReceipt(ctx context.Context, txHash common.Hash) (*Receipt, error)
	Subscribe(ctx context.Context, filter SubscribeFilter, sink chan<- NormalizedEvent) error
	Call(ctx context.Context, to common.Address, calldata []byte) ([]byte, error)
	Close()
}

type EndpointTransport interface {
	Transport
	SendEndpoint(ctx context.Context, endpoint string, calldata []byte) (common.Hash, error)
	CallEndpoint(ctx context.Context, endpoint string, calldata []byte) ([]byte, error)
}
