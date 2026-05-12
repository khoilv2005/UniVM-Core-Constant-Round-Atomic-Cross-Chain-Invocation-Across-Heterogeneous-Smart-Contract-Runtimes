package proof

import "github.com/ethereum/go-ethereum/common"

func MockReceiptProof(txHash common.Hash) (common.Hash, []common.Hash) {
	if txHash == (common.Hash{}) {
		txHash = common.HexToHash("0x1")
	}
	return txHash, []common.Hash{txHash}
}
