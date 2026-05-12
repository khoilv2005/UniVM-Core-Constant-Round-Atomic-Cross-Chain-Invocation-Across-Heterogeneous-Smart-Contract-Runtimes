package transport

import (
	"context"
	"sync"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

type NonceManager struct {
	mu          sync.Mutex
	nextNonce   uint64
	initialized bool
}

func NewNonceManager() *NonceManager {
	return &NonceManager{}
}

func (m *NonceManager) Next(ctx context.Context, client *ethclient.Client, addr common.Address) (uint64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.initialized {
		nonce, err := client.PendingNonceAt(ctx, addr)
		if err != nil {
			return 0, err
		}
		m.nextNonce = nonce
		m.initialized = true
	}

	nonce := m.nextNonce
	m.nextNonce++
	return nonce, nil
}

func (m *NonceManager) Sync(ctx context.Context, client *ethclient.Client, addr common.Address) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	nonce, err := client.PendingNonceAt(ctx, addr)
	if err != nil {
		return err
	}
	m.nextNonce = nonce
	m.initialized = true
	return nil
}
