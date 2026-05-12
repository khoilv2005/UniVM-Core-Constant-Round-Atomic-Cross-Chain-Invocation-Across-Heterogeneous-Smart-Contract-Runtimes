package transport

import (
	"context"
	"math/big"

	"github.com/ethereum/go-ethereum/ethclient"
)

const (
	DefaultGasLimit     uint64 = 3_000_000
	DefaultGasPriceGwei uint64 = 1
)

func ResolveGasLimit(configured uint64) uint64 {
	if configured > 0 {
		return configured
	}
	return DefaultGasLimit
}

func ResolveGasPrice(ctx context.Context, client *ethclient.Client, configuredGwei uint64) (*big.Int, error) {
	if configuredGwei > 0 {
		return new(big.Int).Mul(big.NewInt(int64(configuredGwei)), big.NewInt(1_000_000_000)), nil
	}
	gasPrice, err := client.SuggestGasPrice(ctx)
	if err == nil && gasPrice != nil && gasPrice.Sign() > 0 {
		return gasPrice, nil
	}
	return new(big.Int).Mul(big.NewInt(int64(DefaultGasPriceGwei)), big.NewInt(1_000_000_000)), nil
}
