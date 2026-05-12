package receipt

import (
	"context"

	"github.com/ethereum/go-ethereum/common"
	"github.com/xsmart/relayer/internal/transport"
)

type Service struct{}

func NewService() *Service {
	return &Service{}
}

func (s *Service) Wait(ctx context.Context, client *transport.EVMClient, txHash common.Hash) (*transport.Receipt, error) {
	return client.WaitReceipt(ctx, txHash)
}
