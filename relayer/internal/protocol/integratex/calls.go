package integratex

import (
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

var travelDAppABI = mustABI(`[
  {"inputs":[{"internalType":"uint256","name":"txId","type":"uint256"},{"internalType":"uint256","name":"chainId","type":"uint256"},{"internalType":"bytes","name":"stateData","type":"bytes"}],"name":"receiveLockResponse","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"txId","type":"uint256"},{"internalType":"uint256","name":"chainId","type":"uint256"},{"internalType":"bytes[]","name":"stateDataList","type":"bytes[]"}],"name":"receiveLockResponseBatch","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"txId","type":"uint256"},{"internalType":"address","name":"stateContract","type":"address"}],"name":"receiveUpdateAck","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"txId","type":"uint256"},{"internalType":"address[]","name":"stateContracts","type":"address[]"}],"name":"receiveUpdateAckBatch","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"txId","type":"uint256"}],"name":"startUpdating","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"txId","type":"uint256"}],"name":"confirmUpdateComplete","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"txId","type":"uint256"},{"internalType":"string","name":"reason","type":"string"}],"name":"triggerRollback","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"txId","type":"uint256"}],"name":"checkTimeout","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"txId","type":"uint256"}],"name":"getUpdatePayloads","outputs":[{"internalType":"address[]","name":"stateContracts","type":"address[]"},{"internalType":"uint256[]","name":"chainIds","type":"uint256[]"},{"internalType":"bytes[]","name":"updateData","type":"bytes[]"}],"stateMutability":"view","type":"function"}
]`)

var bridgeABI = mustABI(`[
  {"inputs":[{"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"internalType":"address[]","name":"stateContracts","type":"address[]"},{"internalType":"bytes[]","name":"lockArgs","type":"bytes[]"},{"internalType":"uint256","name":"timeoutBlocks","type":"uint256"},{"internalType":"uint256","name":"executionChainBlockNumber","type":"uint256"},{"internalType":"bytes32[]","name":"merkleProof","type":"bytes32[]"},{"internalType":"bytes32","name":"receiptHash","type":"bytes32"}],"name":"receiveLockRequest","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"internalType":"address[]","name":"stateContracts","type":"address[]"},{"internalType":"bytes[]","name":"updateData","type":"bytes[]"},{"internalType":"uint256","name":"executionChainBlockNumber","type":"uint256"},{"internalType":"bytes32[]","name":"merkleProof","type":"bytes32[]"},{"internalType":"bytes32","name":"receiptHash","type":"bytes32"}],"name":"receiveUpdateRequest","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"internalType":"address[]","name":"stateContracts","type":"address[]"},{"internalType":"uint256","name":"executionChainBlockNumber","type":"uint256"},{"internalType":"bytes32[]","name":"merkleProof","type":"bytes32[]"},{"internalType":"bytes32","name":"receiptHash","type":"bytes32"}],"name":"receiveRollbackRequest","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"crossChainTxId","type":"uint256"}],"name":"completeExecution","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"target","type":"address"},{"internalType":"uint256","name":"crossChainTxId","type":"uint256"}],"name":"retryUnlock","outputs":[],"stateMutability":"nonpayable","type":"function"}
]`)

func NewCallReceiveLockResponse(txID uint64, chainID uint64, stateData []byte) ([]byte, error) {
	return travelDAppABI.Pack("receiveLockResponse", u(txID), u(chainID), stateData)
}

func NewCallReceiveLockResponseBatch(txID uint64, chainID uint64, stateDataList [][]byte) ([]byte, error) {
	return travelDAppABI.Pack("receiveLockResponseBatch", u(txID), u(chainID), stateDataList)
}

func NewCallReceiveUpdateAck(txID uint64, stateContract common.Address) ([]byte, error) {
	return travelDAppABI.Pack("receiveUpdateAck", u(txID), stateContract)
}

func NewCallReceiveUpdateAckBatch(txID uint64, stateContracts []common.Address) ([]byte, error) {
	return travelDAppABI.Pack("receiveUpdateAckBatch", u(txID), stateContracts)
}

func NewCallStartUpdating(txID uint64) ([]byte, error) {
	return travelDAppABI.Pack("startUpdating", u(txID))
}

func NewCallConfirmUpdateComplete(txID uint64) ([]byte, error) {
	return travelDAppABI.Pack("confirmUpdateComplete", u(txID))
}

func NewCallTriggerRollback(txID uint64, reason string) ([]byte, error) {
	return travelDAppABI.Pack("triggerRollback", u(txID), reason)
}

func NewCallCheckTimeout(txID uint64) ([]byte, error) {
	return travelDAppABI.Pack("checkTimeout", u(txID))
}

func NewCallGetUpdatePayloads(txID uint64) ([]byte, error) {
	return travelDAppABI.Pack("getUpdatePayloads", u(txID))
}

func DecodeGetUpdatePayloads(raw []byte) ([]common.Address, []*big.Int, [][]byte, error) {
	values, err := travelDAppABI.Unpack("getUpdatePayloads", raw)
	if err != nil {
		return nil, nil, nil, err
	}
	if len(values) != 3 {
		return nil, nil, nil, nil
	}
	stateContracts, _ := values[0].([]common.Address)
	chainIDs, _ := values[1].([]*big.Int)
	updateData, _ := values[2].([][]byte)
	return stateContracts, chainIDs, updateData, nil
}

func NewCallReceiveLockRequest(txID uint64, stateContracts []common.Address, lockArgs [][]byte, timeoutBlocks uint64) ([]byte, error) {
	return bridgeABI.Pack("receiveLockRequest", u(txID), stateContracts, lockArgs, u(timeoutBlocks), u(0), [][32]byte{}, [32]byte{})
}

func NewCallReceiveUpdateRequest(txID uint64, stateContracts []common.Address, updateData [][]byte) ([]byte, error) {
	return bridgeABI.Pack("receiveUpdateRequest", u(txID), stateContracts, updateData, u(0), [][32]byte{}, [32]byte{})
}

func NewCallReceiveRollbackRequest(txID uint64, stateContracts []common.Address) ([]byte, error) {
	return bridgeABI.Pack("receiveRollbackRequest", u(txID), stateContracts, u(0), [][32]byte{}, [32]byte{})
}

func NewCallCompleteExecution(txID uint64) ([]byte, error) {
	return bridgeABI.Pack("completeExecution", u(txID))
}

func NewCallRetryUnlock(target common.Address, txID uint64) ([]byte, error) {
	return bridgeABI.Pack("retryUnlock", target, u(txID))
}

func mustABI(raw string) abi.ABI {
	parsed, err := abi.JSON(strings.NewReader(raw))
	if err != nil {
		panic(err)
	}
	return parsed
}

func u(v uint64) *big.Int {
	return new(big.Int).SetUint64(v)
}
