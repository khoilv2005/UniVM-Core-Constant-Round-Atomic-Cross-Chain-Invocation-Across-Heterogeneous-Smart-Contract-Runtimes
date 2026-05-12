package event

import (
	"context"
	"log"

	"github.com/ethereum/go-ethereum/common"
	"github.com/xsmart/relayer/internal/config"
	protocolcommon "github.com/xsmart/relayer/internal/protocol/common"
	"github.com/xsmart/relayer/internal/transport"
)

type Listener struct {
	registry *Registry
}

func NewListener(registry *Registry) *Listener {
	return &Listener{registry: registry}
}

func (l *Listener) Start(ctx context.Context, cfg *config.Config, clients map[string]*transport.EVMClient, sink chan<- protocolcommon.NormalizedEvent) error {
	specs := BuildWatchSpecs(cfg, l.registry)
	for _, spec := range specs {
		client := clients[spec.ChainKey]
		if client == nil {
			continue
		}

		rawSink := make(chan transport.NormalizedEvent, 128)
		if err := client.Subscribe(ctx, transport.SubscribeFilter{
			ChainName: spec.ChainKey,
			ChainID:   spec.ChainID,
			Addresses: []common.Address{spec.Address},
			Topics:    l.registry.AllTopics(),
		}, rawSink); err != nil {
			return err
		}

		go func(spec WatchSpec, rawSink <-chan transport.NormalizedEvent) {
			for {
				select {
				case <-ctx.Done():
					return
				case raw, ok := <-rawSink:
					if !ok {
						return
					}
					ev, err := l.registry.Decode(spec, raw.RawLog)
					if err != nil {
						log.Printf("decode %s/%s failed: %v", spec.ChainKey, spec.ContractKind, err)
						continue
					}
					select {
					case sink <- ev:
					case <-ctx.Done():
						return
					}
				}
			}
		}(spec, rawSink)
	}
	return nil
}
