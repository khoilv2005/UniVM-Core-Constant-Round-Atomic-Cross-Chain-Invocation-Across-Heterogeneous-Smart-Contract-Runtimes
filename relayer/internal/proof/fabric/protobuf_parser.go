package fabric

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	fabriccommon "github.com/hyperledger/fabric-protos-go-apiv2/common"
	"github.com/hyperledger/fabric-protos-go-apiv2/ledger/rwset"
	"github.com/hyperledger/fabric-protos-go-apiv2/peer"
	"google.golang.org/protobuf/proto"
)

type ParsedTransactionEvidence struct {
	BlockHash                   string
	ChannelID                   string
	TxID                        string
	ValidationCode              string
	ChaincodeName               string
	ChaincodeVersion            string
	Namespace                   string
	ProposalResponsePayload     []byte
	ProposalResponsePayloadHash string
	Endorsements                []Endorsement
	RWSet                       []byte
	RWSetHash                   string
}

func ParseBlockTransactionEvidence(blockBytes []byte, expectedTxID string) (ParsedTransactionEvidence, error) {
	var block fabriccommon.Block
	if err := proto.Unmarshal(blockBytes, &block); err != nil {
		return ParsedTransactionEvidence{}, fmt.Errorf("fabric block parse failed: %w", err)
	}
	if block.Data == nil || len(block.Data.Data) == 0 {
		return ParsedTransactionEvidence{}, fmt.Errorf("fabric block has no envelopes")
	}
	validationCodes := transactionValidationCodes(&block)
	for idx, envelopeBytes := range block.Data.Data {
		parsed, err := parseEnvelopeTransaction(envelopeBytes)
		if err != nil {
			return ParsedTransactionEvidence{}, err
		}
		if parsed.TxID != expectedTxID {
			continue
		}
		if idx < len(validationCodes) {
			parsed.ValidationCode = validationCodeName(validationCodes[idx])
		}
		if parsed.ValidationCode == "" {
			parsed.ValidationCode = "UNKNOWN"
		}
		blockHash := sha256.Sum256(blockBytes)
		parsed.BlockHash = hex.EncodeToString(blockHash[:])
		return parsed, nil
	}
	return ParsedTransactionEvidence{}, fmt.Errorf("fabric block does not contain tx %q", expectedTxID)
}

func parseEnvelopeTransaction(envelopeBytes []byte) (ParsedTransactionEvidence, error) {
	var envelope fabriccommon.Envelope
	if err := proto.Unmarshal(envelopeBytes, &envelope); err != nil {
		return ParsedTransactionEvidence{}, fmt.Errorf("fabric envelope parse failed: %w", err)
	}
	var payload fabriccommon.Payload
	if err := proto.Unmarshal(envelope.Payload, &payload); err != nil {
		return ParsedTransactionEvidence{}, fmt.Errorf("fabric payload parse failed: %w", err)
	}
	if payload.Header == nil {
		return ParsedTransactionEvidence{}, fmt.Errorf("fabric payload header is missing")
	}
	var channelHeader fabriccommon.ChannelHeader
	if err := proto.Unmarshal(payload.Header.ChannelHeader, &channelHeader); err != nil {
		return ParsedTransactionEvidence{}, fmt.Errorf("fabric channel header parse failed: %w", err)
	}
	var tx peer.Transaction
	if err := proto.Unmarshal(payload.Data, &tx); err != nil {
		return ParsedTransactionEvidence{}, fmt.Errorf("fabric transaction parse failed: %w", err)
	}
	if len(tx.Actions) == 0 {
		return ParsedTransactionEvidence{}, fmt.Errorf("fabric transaction has no actions")
	}
	var actionPayload peer.ChaincodeActionPayload
	if err := proto.Unmarshal(tx.Actions[0].Payload, &actionPayload); err != nil {
		return ParsedTransactionEvidence{}, fmt.Errorf("fabric chaincode action payload parse failed: %w", err)
	}
	if actionPayload.Action == nil {
		return ParsedTransactionEvidence{}, fmt.Errorf("fabric endorsed action is missing")
	}
	var responsePayload peer.ProposalResponsePayload
	if err := proto.Unmarshal(actionPayload.Action.ProposalResponsePayload, &responsePayload); err != nil {
		return ParsedTransactionEvidence{}, fmt.Errorf("fabric proposal response payload parse failed: %w", err)
	}
	var chaincodeAction peer.ChaincodeAction
	if err := proto.Unmarshal(responsePayload.Extension, &chaincodeAction); err != nil {
		return ParsedTransactionEvidence{}, fmt.Errorf("fabric chaincode action parse failed: %w", err)
	}
	var txRWSet rwset.TxReadWriteSet
	if err := proto.Unmarshal(chaincodeAction.Results, &txRWSet); err != nil {
		return ParsedTransactionEvidence{}, fmt.Errorf("fabric rw-set parse failed: %w", err)
	}
	namespace := ""
	if len(txRWSet.NsRwset) > 0 {
		namespace = txRWSet.NsRwset[0].Namespace
	}
	rwHash := sha256.Sum256(chaincodeAction.Results)
	payloadHash := sha256.Sum256(actionPayload.Action.ProposalResponsePayload)
	parsed := ParsedTransactionEvidence{
		ChannelID:                   channelHeader.ChannelId,
		TxID:                        channelHeader.TxId,
		Namespace:                   namespace,
		ProposalResponsePayload:     actionPayload.Action.ProposalResponsePayload,
		ProposalResponsePayloadHash: hex.EncodeToString(payloadHash[:]),
		RWSet:                       chaincodeAction.Results,
		RWSetHash:                   hex.EncodeToString(rwHash[:]),
	}
	if chaincodeAction.ChaincodeId != nil {
		parsed.ChaincodeName = chaincodeAction.ChaincodeId.Name
		parsed.ChaincodeVersion = chaincodeAction.ChaincodeId.Version
	}
	for i, endorsement := range actionPayload.Action.Endorsements {
		parsed.Endorsements = append(parsed.Endorsements, Endorsement{
			IdentityID: fmt.Sprintf("endorser-%d", i),
			Signature:  hex.EncodeToString(endorsement.Signature),
		})
	}
	return parsed, nil
}

func transactionValidationCodes(block *fabriccommon.Block) []byte {
	if block == nil || block.Metadata == nil {
		return nil
	}
	idx := int(fabriccommon.BlockMetadataIndex_TRANSACTIONS_FILTER)
	if idx < 0 || idx >= len(block.Metadata.Metadata) {
		return nil
	}
	return block.Metadata.Metadata[idx]
}

func validationCodeName(code byte) string {
	if peer.TxValidationCode(code) == peer.TxValidationCode_VALID {
		return "VALID"
	}
	return peer.TxValidationCode(code).String()
}
