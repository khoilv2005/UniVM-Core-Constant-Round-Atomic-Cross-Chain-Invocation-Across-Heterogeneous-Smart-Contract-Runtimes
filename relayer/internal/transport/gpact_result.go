package transport

import "encoding/binary"

func gpactSegmentResultBytes(txID [32]byte, callTreeHash [32]byte, chainID uint64, segmentID uint64) []byte {
	result := make([]byte, 0, 80)
	result = append(result, txID[:]...)
	result = append(result, callTreeHash[:]...)
	result = binary.BigEndian.AppendUint64(result, chainID)
	result = binary.BigEndian.AppendUint64(result, segmentID)
	return result
}
