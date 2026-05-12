package main

import (
	"encoding/hex"
	"testing"
)

func TestVasspSlotIDDeterministic(t *testing.T) {
	got := vasspSlotID("HotelBooking", "LOCK_%s", []byte{0x12, 0x34}, []byte{0xab, 0xcd})
	want, err := hex.DecodeString("716bf0cd0216d52c42772c831b4e028d2bb533a4c4acf882b209f20483d89f0b")
	if err != nil {
		t.Fatalf("decode want: %v", err)
	}
	if hex.EncodeToString(got[:]) != hex.EncodeToString(want) {
		t.Fatalf("slot id mismatch: got %x want %x", got, want)
	}
}

func TestVasspEncodeSinglePairRlpShape(t *testing.T) {
	var slot [32]byte
	for i := range slot {
		slot[i] = 0x11
	}

	encoded, err := vasspEncode([]vasspPair{{
		SlotID:   slot,
		ABIValue: []byte{0x12, 0x34},
	}})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	wantHex := "e5e4a01111111111111111111111111111111111111111111111111111111111111111821234"
	if hex.EncodeToString(encoded) != wantHex {
		t.Fatalf("rlp mismatch: got %x want %s", encoded, wantHex)
	}
}

func TestVasspEncodeUint256Word(t *testing.T) {
	encoded := vasspEncodeUint256(0x1234)
	wantHex := "0000000000000000000000000000000000000000000000000000000000001234"
	if hex.EncodeToString(encoded) != wantHex {
		t.Fatalf("uint256 mismatch: got %x want %s", encoded, wantHex)
	}
}

func TestVasspEncodeMetaTupleShape(t *testing.T) {
	encoded := vasspEncodeMetaTuple("bridgeMSP", 10, 100, 1)
	if len(encoded) != 32*6 {
		t.Fatalf("unexpected encoded len: got %d want %d", len(encoded), 32*6)
	}
	if hex.EncodeToString(encoded[:32]) != "0000000000000000000000000000000000000000000000000000000000000080" {
		t.Fatalf("offset word mismatch: got %x", encoded[:32])
	}
	if hex.EncodeToString(encoded[32:64]) != "000000000000000000000000000000000000000000000000000000000000000a" {
		t.Fatalf("price word mismatch: got %x", encoded[32:64])
	}
	if hex.EncodeToString(encoded[64:96]) != "0000000000000000000000000000000000000000000000000000000000000064" {
		t.Fatalf("remain word mismatch: got %x", encoded[64:96])
	}
	if hex.EncodeToString(encoded[96:128]) != "0000000000000000000000000000000000000000000000000000000000000001" {
		t.Fatalf("lockSize word mismatch: got %x", encoded[96:128])
	}
	if hex.EncodeToString(encoded[128:160]) != "0000000000000000000000000000000000000000000000000000000000000009" {
		t.Fatalf("string len word mismatch: got %x", encoded[128:160])
	}
	if string(encoded[160:169]) != "bridgeMSP" {
		t.Fatalf("string payload mismatch: got %q", string(encoded[160:169]))
	}
}

func TestVasspValidateRejectsEmptyABIValue(t *testing.T) {
	err := vasspValidatePairs([]vasspPair{{}})
	if err == nil {
		t.Fatal("expected validation error for empty ABI value")
	}
}
