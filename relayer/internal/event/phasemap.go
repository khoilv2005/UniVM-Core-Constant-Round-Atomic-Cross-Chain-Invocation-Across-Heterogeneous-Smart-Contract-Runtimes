package event

import protocolcommon "github.com/xsmart/relayer/internal/protocol/common"

func PhaseFor(protocol protocolcommon.ProtocolName, eventName string) string {
	switch protocol {
	case protocolcommon.ProtocolIntegrateX:
		switch eventName {
		case "CrossChainExecutionInitiated":
			return "SUBMIT"
		case "LockingPhaseStarted", "CrossChainLockRequested":
			return "LOCK_REQ"
		case "LockResponseReceived", "CrossChainLockResponse":
			return "LOCK_ACK"
		case "IntegratedExecutionCompleted", "IntegratedExecutionPerformed":
			return "EXECUTE"
		case "UpdatingPhaseStarted", "CrossChainUpdateRequested":
			return "UPDATE_REQ"
		case "UpdateAckReceived", "CrossChainUpdateAck":
			return "UPDATE_ACK"
		case "CrossChainExecutionCompleted":
			return "FINAL_CONFIRM"
		case "CrossChainRollback", "CrossChainExecutionRolledBack", "IntegratedExecutionFailed", "TimeoutDetected", "UnlockFailed", "UnlockRetryRequested", "UnlockForcedTimeout":
			return "ABORT"
		}
	case protocolcommon.ProtocolAtom:
		switch eventName {
		case "WriteOnlyInvocationRequested", "ReadWriteInvocationRequested", "InvocationStarted":
			return "INVOKE_INIT"
		case "OperationProofSubmitted":
			return "OP_PROOF_SUBMITTED"
		case "JudgeVoteSubmitted":
			return "JUDGE_VOTE"
		case "InvocationFinalized", "InvocationInvalidated", "InvocationForceSettled":
			return "SETTLE"
		case "AtomHotelUnlocked", "AtomHotelUndoUnlocked",
			"AtomTrainUnlocked", "AtomTrainUndoUnlocked",
			"AtomFlightUnlocked", "AtomFlightUndoUnlocked",
			"AtomTaxiUnlocked", "AtomTaxiUndoUnlocked":
			return "FINAL_CONFIRM"
		}
	case protocolcommon.ProtocolGPACT:
		switch eventName {
		case "BookingStarted":
			return "SUBMIT"
		case "StartEvent":
			return "START"
		case "SegmentEvent":
			return "SEGMENT"
		case "RootEvent":
			return "ROOT"
		case "SignallingEvent":
			return "SIGNAL"
		case "CompleteExecutionReceipt":
			return "FINAL_CONFIRM"
		case "RootTimedOut", "LockTimedOut":
			return "ABORT"
		}
	case protocolcommon.ProtocolXSmart:
		switch eventName {
		case "CrossChainLockRequested":
			return "LOCK_REQ"
		case "CrossChainLockResponse":
			return "LOCK_ACK"
		case "CallTreeNodeExecuted", "IntegratedExecutionPerformed":
			return "EXECUTE"
		case "CrossChainUpdateRequested":
			return "UPDATE_REQ"
		case "CrossChainUpdateAck":
			return "UPDATE_ACK"
		case "CompleteExecutionReceipt":
			return "FINAL_CONFIRM"
		case "CrossChainRollback", "IntegratedExecutionFailed", "UnlockFailed", "UnlockRetryRequested", "UnlockForcedTimeout", "TranslationVerificationFailed":
			return "ABORT"
		}
	}
	return "OTHER"
}
