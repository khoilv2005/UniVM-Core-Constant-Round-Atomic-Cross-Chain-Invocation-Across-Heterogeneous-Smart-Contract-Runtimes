package event

import (
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
)

var integratexABI = mustABI(`[
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"indexed":false,"internalType":"string","name":"serviceId","type":"string"},{"indexed":false,"internalType":"address[]","name":"stateContracts","type":"address[]"},{"indexed":false,"internalType":"uint256","name":"executionChainId","type":"uint256"}],"name":"CrossChainLockRequested","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"indexed":false,"internalType":"address","name":"stateContract","type":"address"},{"indexed":false,"internalType":"bytes","name":"lockedState","type":"bytes"}],"name":"CrossChainLockResponse","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"indexed":true,"internalType":"uint256","name":"sourceChainId","type":"uint256"},{"indexed":false,"internalType":"bytes[]","name":"lockedStates","type":"bytes[]"}],"name":"CrossChainLockResponseBatch","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"indexed":false,"internalType":"address[]","name":"stateContracts","type":"address[]"},{"indexed":false,"internalType":"bytes[]","name":"updateData","type":"bytes[]"}],"name":"CrossChainUpdateRequested","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"indexed":false,"internalType":"address","name":"stateContract","type":"address"},{"indexed":false,"internalType":"bool","name":"success","type":"bool"}],"name":"CrossChainUpdateAck","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"indexed":true,"internalType":"uint256","name":"sourceChainId","type":"uint256"},{"indexed":false,"internalType":"address[]","name":"stateContracts","type":"address[]"}],"name":"CrossChainUpdateAckBatch","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"indexed":false,"internalType":"address[]","name":"stateContracts","type":"address[]"}],"name":"CrossChainRollback","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"target","type":"address"},{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"}],"name":"UnlockFailed","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"target","type":"address"},{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"attempt","type":"uint256"}],"name":"UnlockRetryRequested","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"target","type":"address"},{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"}],"name":"UnlockForcedTimeout","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"indexed":false,"internalType":"string","name":"serviceId","type":"string"},{"indexed":false,"internalType":"address","name":"logicContract","type":"address"},{"indexed":false,"internalType":"bytes","name":"resultHash","type":"bytes"}],"name":"IntegratedExecutionPerformed","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"indexed":false,"internalType":"string","name":"serviceId","type":"string"},{"indexed":false,"internalType":"bytes","name":"reason","type":"bytes"}],"name":"IntegratedExecutionFailed","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"indexed":true,"internalType":"address","name":"user","type":"address"},{"indexed":false,"internalType":"uint256","name":"numRooms","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"numOutboundTickets","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"numReturnTickets","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"timeoutBlocks","type":"uint256"}],"name":"CrossChainExecutionInitiated","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"indexed":false,"internalType":"address[]","name":"stateContracts","type":"address[]"},{"indexed":false,"internalType":"uint256[]","name":"chainIds","type":"uint256[]"}],"name":"LockingPhaseStarted","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"chainId","type":"uint256"},{"indexed":false,"internalType":"bytes","name":"stateData","type":"bytes"}],"name":"LockResponseReceived","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"}],"name":"LockingPhaseCompleted","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"hotelCost","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"outboundTrainCost","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"returnTrainCost","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"totalCost","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"newHotelRemain","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"newTrainSeats","type":"uint256"}],"name":"IntegratedExecutionCompleted","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"}],"name":"UpdatingPhaseStarted","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"indexed":false,"internalType":"address","name":"stateContract","type":"address"}],"name":"UpdateAckReceived","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"}],"name":"UpdatingPhaseCompleted","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"}],"name":"CrossChainExecutionCompleted","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"},{"indexed":false,"internalType":"uint8","name":"fromStatus","type":"uint8"},{"indexed":false,"internalType":"string","name":"reason","type":"string"}],"name":"CrossChainExecutionRolledBack","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"crossChainTxId","type":"uint256"}],"name":"TimeoutDetected","type":"event"}
]`)

func mustABI(raw string) abi.ABI {
	parsed, err := abi.JSON(strings.NewReader(raw))
	if err != nil {
		panic(err)
	}
	return parsed
}
