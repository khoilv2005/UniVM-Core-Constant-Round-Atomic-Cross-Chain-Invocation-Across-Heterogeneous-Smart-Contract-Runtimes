package relay

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	protocolcommon "github.com/xsmart/relayer/internal/protocol/common"
	"github.com/xsmart/relayer/internal/transport"
)

type Marker interface {
	EmitAction(action protocolcommon.Action, txHash common.Hash)
	EmitReceipt(action protocolcommon.Action, receipt *transport.Receipt)
}

type Scheduler struct {
	workers    int
	retryDelay time.Duration
	clients    map[uint64]map[string]transport.Transport
	store      *CheckpointStore
	marker     Marker

	queue chan protocolcommon.Action
	wg    sync.WaitGroup
}

func NewScheduler(workers int, retryDelay time.Duration, clients map[uint64]map[string]transport.Transport, store *CheckpointStore, marker Marker) *Scheduler {
	if workers <= 0 {
		workers = 1
	}
	return &Scheduler{
		workers:    workers,
		retryDelay: retryDelay,
		clients:    clients,
		store:      store,
		marker:     marker,
		queue:      make(chan protocolcommon.Action, 1024),
	}
}

func (s *Scheduler) Start(ctx context.Context) {
	for i := 0; i < s.workers; i++ {
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case action := <-s.queue:
					s.process(ctx, action)
				}
			}
		}()
	}

	for _, action := range s.store.Pending() {
		select {
		case s.queue <- action:
		case <-ctx.Done():
			return
		}
	}
}

func (s *Scheduler) Wait() {
	s.wg.Wait()
}

func (s *Scheduler) Enqueue(actions ...protocolcommon.Action) error {
	for _, action := range actions {
		if existing, ok := s.store.Get(action.ID); ok {
			if existing.Status == protocolcommon.ActionDone || existing.Status == protocolcommon.ActionInFlight {
				continue
			}
		}
		if err := s.store.Put(action); err != nil {
			return err
		}
		s.queue <- action
	}
	return nil
}

func (s *Scheduler) process(ctx context.Context, action protocolcommon.Action) {
	client, err := s.clientFor(action)
	if err != nil {
		s.onFailure(ctx, action, err)
		return
	}

	action.Status = protocolcommon.ActionInFlight
	action.Attempts++
	if err := s.store.Put(action); err != nil {
		return
	}

	var txHash common.Hash
	if action.LastTxHash != "" {
		txHash = common.HexToHash(action.LastTxHash)
	} else if action.DestVM == protocolcommon.DestVMEVM && action.DestContract != (common.Address{}) {
		txHash, err = client.Send(ctx, action.DestContract, action.Calldata)
		if err != nil {
			s.onFailure(ctx, action, err)
			return
		}
	} else if action.DestEndpoint != "" {
		endpointClient, ok := client.(transport.EndpointTransport)
		if !ok {
			s.onFailure(ctx, action, fmt.Errorf("client does not support endpoint send for action %s", action.ID))
			return
		}
		txHash, err = endpointClient.SendEndpoint(ctx, action.DestEndpoint, action.Calldata)
		if err != nil {
			s.onFailure(ctx, action, err)
			return
		}
	} else {
		s.onFailure(ctx, action, fmt.Errorf("no destination configured for action %s", action.ID))
		return
	}
	action.LastTxHash = txHash.Hex()
	action.Status = protocolcommon.ActionInFlight
	if err := s.store.Put(action); err != nil {
		return
	}
	if s.marker != nil {
		s.marker.EmitAction(action, txHash)
	}

	receipt, err := client.WaitReceipt(ctx, txHash)
	if err != nil {
		s.onFailure(ctx, action, err)
		return
	}
	if !receipt.Success {
		s.onFailure(ctx, action, fmt.Errorf("transaction reverted: %s", txHash.Hex()))
		return
	}
	if s.marker != nil {
		s.marker.EmitReceipt(action, receipt)
	}

	action.Status = protocolcommon.ActionDone
	action.LastError = ""
	_ = s.store.Put(action)
}

func (s *Scheduler) clientFor(action protocolcommon.Action) (transport.Transport, error) {
	pool, ok := s.clients[action.DestChainID]
	if !ok {
		return nil, fmt.Errorf("no client pool for chain %d", action.DestChainID)
	}
	if action.Signer != "" {
		if client, ok := pool[strings.ToLower(action.Signer)]; ok {
			return client, nil
		}
		return nil, fmt.Errorf("no signer client for chain %d signer %s", action.DestChainID, action.Signer)
	}
	if client, ok := pool[""]; ok {
		return client, nil
	}
	for _, client := range pool {
		return client, nil
	}
	return nil, errors.New("empty client pool")
}

func (s *Scheduler) onFailure(ctx context.Context, action protocolcommon.Action, err error) {
	action.Status = protocolcommon.ActionFailed
	action.LastError = err.Error()

	if isAlreadyHandled(err) {
		action.Status = protocolcommon.ActionDone
		_ = s.store.Put(action)
		return
	}
	if action.Attempts >= action.MaxRetries {
		action.Status = protocolcommon.ActionAbandoned
		_ = s.store.Put(action)
		return
	}
	if shouldResendWithFreshHash(action, err) {
		action.LastTxHash = ""
	}
	if err := s.store.Put(action); err != nil {
		return
	}

	go func() {
		backoff := s.retryDelay
		if backoff <= 0 {
			backoff = time.Second
		}
		for i := 1; i < action.Attempts; i++ {
			backoff *= 2
		}
		timer := time.NewTimer(backoff)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			action.Status = protocolcommon.ActionPending
			_ = s.store.Put(action)
			select {
			case s.queue <- action:
			case <-ctx.Done():
			}
		}
	}()
}

func shouldResendWithFreshHash(action protocolcommon.Action, err error) bool {
	if err == nil || action.LastTxHash == "" || action.DestVM != protocolcommon.DestVMEVM {
		return false
	}
	msg := strings.ToLower(err.Error())
	needles := []string{
		"receipt timeout",
		"context deadline exceeded",
		"transaction not found",
		"not found",
	}
	for _, needle := range needles {
		if strings.Contains(msg, needle) {
			return true
		}
	}
	return false
}

func isAlreadyHandled(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	needles := []string{
		"already processed",
		"already started",
		"already exists",
		"already locked",
		"proof exists",
		"vote exists",
		"already registered",
		"invocation exists",
	}
	for _, needle := range needles {
		if strings.Contains(msg, needle) {
			return true
		}
	}
	return false
}
