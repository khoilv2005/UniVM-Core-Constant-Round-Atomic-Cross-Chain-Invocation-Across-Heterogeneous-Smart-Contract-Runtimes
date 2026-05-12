package fabric

import (
	"testing"

	fabriccommon "github.com/hyperledger/fabric-protos-go-apiv2/common"
	"github.com/hyperledger/fabric-protos-go-apiv2/ledger/rwset"
	"github.com/hyperledger/fabric-protos-go-apiv2/peer"
	"google.golang.org/protobuf/proto"
)

func TestParseBlockTransactionEvidence(t *testing.T) {
	blockBytes := makeFabricBlockBytes(t, "tx-1")

	got, err := ParseBlockTransactionEvidence(blockBytes, "tx-1")
	if err != nil {
		t.Fatalf("ParseBlockTransactionEvidence failed: %v", err)
	}
	if got.ChannelID != "booking-channel" || got.TxID != "tx-1" {
		t.Fatalf("unexpected channel/tx: %+v", got)
	}
	if got.ChaincodeName != "hotel" || got.ChaincodeVersion != "v1" || got.Namespace != "hotel" {
		t.Fatalf("unexpected chaincode fields: %+v", got)
	}
	if got.ValidationCode != "VALID" {
		t.Fatalf("unexpected validation code %q", got.ValidationCode)
	}
	if len(got.ProposalResponsePayload) == 0 || got.ProposalResponsePayloadHash == "" || len(got.RWSet) == 0 || got.RWSetHash == "" {
		t.Fatalf("expected hashes and raw payloads, got %+v", got)
	}
	if len(got.Endorsements) != 1 || got.Endorsements[0].Signature == "" {
		t.Fatalf("unexpected endorsements: %+v", got.Endorsements)
	}
}

func TestParseBlockTransactionEvidenceRejectsMissingTx(t *testing.T) {
	blockBytes := makeFabricBlockBytes(t, "tx-1")
	if _, err := ParseBlockTransactionEvidence(blockBytes, "tx-missing"); err == nil {
		t.Fatalf("expected missing tx error")
	}
}

func makeFabricBlockBytes(t *testing.T, txID string) []byte {
	t.Helper()
	txRWSet := &rwset.TxReadWriteSet{
		DataModel: rwset.TxReadWriteSet_KV,
		NsRwset: []*rwset.NsReadWriteSet{
			{Namespace: "hotel", Rwset: []byte("namespace-rwset")},
		},
	}
	txRWSetBytes := mustMarshalProto(t, txRWSet)
	action := &peer.ChaincodeAction{
		Results: txRWSetBytes,
		ChaincodeId: &peer.ChaincodeID{
			Name:    "hotel",
			Version: "v1",
		},
	}
	actionBytes := mustMarshalProto(t, action)
	responsePayload := &peer.ProposalResponsePayload{Extension: actionBytes}
	responsePayloadBytes := mustMarshalProto(t, responsePayload)
	actionPayload := &peer.ChaincodeActionPayload{
		Action: &peer.ChaincodeEndorsedAction{
			ProposalResponsePayload: responsePayloadBytes,
			Endorsements: []*peer.Endorsement{
				{Endorser: []byte("Org1MSP"), Signature: []byte("signature")},
			},
		},
	}
	tx := &peer.Transaction{
		Actions: []*peer.TransactionAction{
			{Payload: mustMarshalProto(t, actionPayload)},
		},
	}
	channelHeader := &fabriccommon.ChannelHeader{
		ChannelId: "booking-channel",
		TxId:      txID,
	}
	payload := &fabriccommon.Payload{
		Header: &fabriccommon.Header{
			ChannelHeader: mustMarshalProto(t, channelHeader),
		},
		Data: mustMarshalProto(t, tx),
	}
	envelope := &fabriccommon.Envelope{Payload: mustMarshalProto(t, payload)}
	block := &fabriccommon.Block{
		Data: &fabriccommon.BlockData{Data: [][]byte{mustMarshalProto(t, envelope)}},
		Metadata: &fabriccommon.BlockMetadata{Metadata: [][]byte{
			nil,
			nil,
			{byte(peer.TxValidationCode_VALID)},
		}},
	}
	return mustMarshalProto(t, block)
}

func mustMarshalProto(t *testing.T, msg proto.Message) []byte {
	t.Helper()
	raw, err := proto.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal proto: %v", err)
	}
	return raw
}
