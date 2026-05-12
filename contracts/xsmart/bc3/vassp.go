package main

import (
	"encoding/binary"
	"errors"

	"golang.org/x/crypto/sha3"
)

type vasspPair struct {
	SlotID   [32]byte
	ABIValue []byte
}

func vasspEncodeUint256(value uint64) []byte {
	out := make([]byte, 32)
	binary.BigEndian.PutUint64(out[24:], value)
	return out
}

func vasspEncodeString(value string) []byte {
	raw := []byte(value)
	paddedLen := ((len(raw) + 31) / 32) * 32
	padded := make([]byte, paddedLen)
	copy(padded, raw)
	return append(vasspEncodeUint256(uint64(len(raw))), padded...)
}

func vasspEncodeMetaTuple(bridge string, price, remain, lockSize uint64) []byte {
	head := make([]byte, 0, 32*4)
	head = append(head, vasspEncodeUint256(32*4)...)
	head = append(head, vasspEncodeUint256(price)...)
	head = append(head, vasspEncodeUint256(remain)...)
	head = append(head, vasspEncodeUint256(lockSize)...)
	return append(head, vasspEncodeString(bridge)...)
}

func vasspSlotID(contractName, slotName string, keys ...[]byte) [32]byte {
	h := sha3.NewLegacyKeccak256()
	_, _ = h.Write([]byte("VASSP"))
	_, _ = h.Write([]byte(contractName))
	_, _ = h.Write([]byte(slotName))
	for _, key := range keys {
		_, _ = h.Write(key)
	}

	var out [32]byte
	sum := h.Sum(nil)
	copy(out[:], sum)
	return out
}

func vasspEncode(pairs []vasspPair) ([]byte, error) {
	encodedPairs := make([][]byte, 0, len(pairs))
	for _, pair := range pairs {
		slotBytes := append([]byte(nil), pair.SlotID[:]...)
		pairItems := [][]byte{
			vasspEncodeBytes(slotBytes),
			vasspEncodeBytes(pair.ABIValue),
		}
		encodedPairs = append(encodedPairs, vasspEncodeList(pairItems))
	}
	return vasspEncodeList(encodedPairs), nil
}

func vasspEncodeBytes(value []byte) []byte {
	if len(value) == 1 && value[0] < 0x80 {
		return append([]byte(nil), value...)
	}
	if len(value) <= 55 {
		out := []byte{byte(0x80 + len(value))}
		return append(out, value...)
	}

	lenBytes := vasspEncodeLength(len(value))
	out := []byte{byte(0xb7 + len(lenBytes))}
	out = append(out, lenBytes...)
	return append(out, value...)
}

func vasspEncodeList(items [][]byte) []byte {
	var payload []byte
	for _, item := range items {
		payload = append(payload, item...)
	}
	if len(payload) <= 55 {
		out := []byte{byte(0xc0 + len(payload))}
		return append(out, payload...)
	}

	lenBytes := vasspEncodeLength(len(payload))
	out := []byte{byte(0xf7 + len(lenBytes))}
	out = append(out, lenBytes...)
	return append(out, payload...)
}

func vasspEncodeLength(length int) []byte {
	if length == 0 {
		return []byte{0}
	}

	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], uint64(length))
	first := 0
	for first < len(buf)-1 && buf[first] == 0 {
		first++
	}
	return append([]byte(nil), buf[first:]...)
}

func vasspValidatePairs(pairs []vasspPair) error {
	for _, pair := range pairs {
		if len(pair.ABIValue) == 0 {
			return errors.New("empty abi value")
		}
	}
	return nil
}
