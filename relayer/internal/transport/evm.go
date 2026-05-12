package transport

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"math/big"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

var sharedNonceManagers sync.Map

const evmReceiptWaitTimeout = 45 * time.Second

type EVMClient struct {
	ChainName      string
	ChainID        *big.Int
	From           common.Address
	HTTP           *ethclient.Client
	WS             *ethclient.Client
	privateKey     *ecdsa.PrivateKey
	gasLimit       uint64
	gasPrice       *big.Int
	nonces         *NonceManager
	finalityBlocks uint64
}

func NewEVMClient(ctx context.Context, chainName, rpcURL, wsURL string, chainID uint64, privateKey *ecdsa.PrivateKey, gasLimit uint64, gasPriceGwei uint64, finalityBlocks uint64) (*EVMClient, error) {
	httpClient, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		return nil, fmt.Errorf("dial http %s: %w", chainName, err)
	}

	var wsClient *ethclient.Client
	if wsURL != "" {
		wsClient, err = ethclient.DialContext(ctx, wsURL)
		if err != nil {
			wsClient = nil
		}
	}

	gasPrice, err := ResolveGasPrice(ctx, httpClient, gasPriceGwei)
	if err != nil {
		httpClient.Close()
		if wsClient != nil {
			wsClient.Close()
		}
		return nil, err
	}

	signChainID := new(big.Int).SetUint64(chainID)
	if actualChainID, err := httpClient.ChainID(ctx); err == nil && actualChainID != nil && actualChainID.Sign() > 0 {
		signChainID = actualChainID
	}
	if finalityBlocks == 0 {
		finalityBlocks = 1
	}

	from := crypto.PubkeyToAddress(privateKey.PublicKey)

	return &EVMClient{
		ChainName:      chainName,
		ChainID:        signChainID,
		From:           from,
		HTTP:           httpClient,
		WS:             wsClient,
		privateKey:     privateKey,
		gasLimit:       ResolveGasLimit(gasLimit),
		gasPrice:       gasPrice,
		nonces:         sharedNonceManager(chainName, from, signChainID),
		finalityBlocks: finalityBlocks,
	}, nil
}

func (c *EVMClient) Send(ctx context.Context, to common.Address, calldata []byte) (common.Hash, error) {
	nonce, err := c.nonces.Next(ctx, c.HTTP, c.From)
	if err != nil {
		return common.Hash{}, err
	}

	tx := types.NewTx(&types.LegacyTx{
		Nonce:    nonce,
		To:       &to,
		Gas:      c.gasLimit,
		GasPrice: new(big.Int).Set(c.gasPrice),
		Value:    big.NewInt(0),
		Data:     calldata,
	})

	signed, err := types.SignTx(tx, types.LatestSignerForChainID(c.ChainID), c.privateKey)
	if err != nil {
		return common.Hash{}, err
	}
	if err := c.HTTP.SendTransaction(ctx, signed); err != nil {
		if isNonceTooLow(err) {
			if syncErr := c.nonces.Sync(ctx, c.HTTP, c.From); syncErr == nil {
				return c.Send(ctx, to, calldata)
			}
		}
		return common.Hash{}, err
	}
	return signed.Hash(), nil
}

func (c *EVMClient) SendEndpoint(ctx context.Context, endpoint string, calldata []byte) (common.Hash, error) {
	if !common.IsHexAddress(endpoint) {
		return common.Hash{}, fmt.Errorf("evm endpoint must be hex address, got %q", endpoint)
	}
	return c.Send(ctx, common.HexToAddress(endpoint), calldata)
}

func (c *EVMClient) WaitReceipt(ctx context.Context, txHash common.Hash) (*Receipt, error) {
	waitCtx, cancel := context.WithTimeout(ctx, evmReceiptWaitTimeout)
	defer cancel()

	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		receipt, err := c.HTTP.TransactionReceipt(waitCtx, txHash)
		if err == nil && receipt != nil {
			if err := c.waitForFinality(waitCtx, receipt.BlockNumber.Uint64()); err != nil {
				return nil, err
			}
			return &Receipt{
				TxHash:      txHash,
				BlockNumber: receipt.BlockNumber.Uint64(),
				GasUsed:     receipt.GasUsed,
				Success:     receipt.Status == types.ReceiptStatusSuccessful,
				Raw:         receipt,
			}, nil
		}
		if err != nil && !errors.Is(err, ethereum.NotFound) {
			return nil, err
		}

		select {
		case <-waitCtx.Done():
			_ = c.nonces.Sync(context.Background(), c.HTTP, c.From)
			if errors.Is(waitCtx.Err(), context.DeadlineExceeded) {
				return nil, fmt.Errorf("receipt timeout for tx %s after %s", txHash.Hex(), evmReceiptWaitTimeout)
			}
			return nil, waitCtx.Err()
		case <-ticker.C:
		}
	}
}

func (c *EVMClient) waitForFinality(ctx context.Context, block uint64) error {
	if c.finalityBlocks <= 1 || block == 0 {
		return nil
	}
	target := block + c.finalityBlocks - 1
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		latest, err := c.HTTP.BlockNumber(ctx)
		if err == nil && latest >= target {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (c *EVMClient) Subscribe(ctx context.Context, filter SubscribeFilter, sink chan<- NormalizedEvent) error {
	if filter.FromBlock == nil {
		if lookbackRaw := strings.TrimSpace(os.Getenv("XSMART_RELAYER_EVM_LOG_LOOKBACK_BLOCKS")); lookbackRaw != "" {
			if lookback, err := strconv.ParseUint(lookbackRaw, 10, 64); err == nil && lookback > 0 {
				if latest, err := c.HTTP.BlockNumber(ctx); err == nil {
					from := uint64(0)
					if latest > lookback {
						from = latest - lookback
					}
					filter.FromBlock = new(big.Int).SetUint64(from)
				}
			}
		}
	}
	query := ethereum.FilterQuery{
		FromBlock: filter.FromBlock,
		Addresses: filter.Addresses,
		Topics:    filter.Topics,
	}

	if c.WS == nil || strings.EqualFold(strings.TrimSpace(os.Getenv("XSMART_RELAYER_FORCE_POLL_LOGS")), "1") {
		go c.pollLogs(ctx, query, filter, sink)
		return nil
	}

	logs := make(chan types.Log, 128)
	sub, err := c.WS.SubscribeFilterLogs(ctx, query, logs)
	if err != nil {
		go c.pollLogs(ctx, query, filter, sink)
		return nil
	}

	go func() {
		defer sub.Unsubscribe()
		for {
			select {
			case <-ctx.Done():
				return
			case err := <-sub.Err():
				if err != nil {
					return
				}
			case entry := <-logs:
				ev := NormalizedEvent{
					ChainName:   filter.ChainName,
					ChainID:     filter.ChainID,
					BlockNumber: entry.BlockNumber,
					TxHash:      entry.TxHash,
					LogIndex:    uint(entry.Index),
					Contract:    entry.Address,
					RawLog:      entry,
					ReceivedAt:  time.Now().UTC(),
				}
				if len(entry.Topics) > 0 {
					ev.Topic0 = entry.Topics[0]
				}
				select {
				case sink <- ev:
				case <-ctx.Done():
					return
				}
			}
		}
	}()

	return nil
}

func (c *EVMClient) pollLogs(ctx context.Context, query ethereum.FilterQuery, filter SubscribeFilter, sink chan<- NormalizedEvent) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	var nextBlock uint64
	if filter.FromBlock != nil {
		nextBlock = filter.FromBlock.Uint64()
	} else {
		latest, err := c.HTTP.BlockNumber(ctx)
		if err != nil {
			nextBlock = 0
		} else {
			nextBlock = latest
		}
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			latest, err := c.HTTP.BlockNumber(ctx)
			if err != nil {
				continue
			}
			if latest < nextBlock {
				continue
			}
			query.FromBlock = new(big.Int).SetUint64(nextBlock)
			query.ToBlock = new(big.Int).SetUint64(latest)
			logs, err := c.HTTP.FilterLogs(ctx, query)
			if err != nil {
				continue
			}
			for _, entry := range logs {
				ev := NormalizedEvent{
					ChainName:   filter.ChainName,
					ChainID:     filter.ChainID,
					BlockNumber: entry.BlockNumber,
					TxHash:      entry.TxHash,
					LogIndex:    uint(entry.Index),
					Contract:    entry.Address,
					RawLog:      entry,
					ReceivedAt:  time.Now().UTC(),
				}
				if len(entry.Topics) > 0 {
					ev.Topic0 = entry.Topics[0]
				}
				select {
				case sink <- ev:
				case <-ctx.Done():
					return
				}
			}
			nextBlock = latest + 1
		}
	}
}

func (c *EVMClient) Call(ctx context.Context, to common.Address, calldata []byte) ([]byte, error) {
	msg := ethereum.CallMsg{
		From: c.From,
		To:   &to,
		Data: calldata,
	}
	return c.HTTP.CallContract(ctx, msg, nil)
}

func (c *EVMClient) CallEndpoint(ctx context.Context, endpoint string, calldata []byte) ([]byte, error) {
	if !common.IsHexAddress(endpoint) {
		return nil, fmt.Errorf("evm endpoint must be hex address, got %q", endpoint)
	}
	return c.Call(ctx, common.HexToAddress(endpoint), calldata)
}

func (c *EVMClient) Close() {
	if c.HTTP != nil {
		c.HTTP.Close()
	}
	if c.WS != nil {
		c.WS.Close()
	}
}

func isNonceTooLow(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "nonce too low") || strings.Contains(msg, "already known")
}

func sharedNonceManager(chainName string, from common.Address, chainID *big.Int) *NonceManager {
	key := strings.ToLower(chainName) + "|" + strings.ToLower(from.Hex()) + "|" + chainID.String()
	manager, _ := sharedNonceManagers.LoadOrStore(key, NewNonceManager())
	return manager.(*NonceManager)
}
