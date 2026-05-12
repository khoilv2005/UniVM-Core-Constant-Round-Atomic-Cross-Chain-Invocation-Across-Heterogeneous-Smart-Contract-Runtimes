package main

import (
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

const (
	keyAuction = "RQ2_AUCTION_%s"
	keyPending = "RQ2_PENDING_%s"
)

type AuctionLogic struct{ contractapi.Contract }

type auctionState struct {
	Seller        string `json:"seller"`
	MinPrice      uint64 `json:"minPrice"`
	HighestBidder string `json:"highestBidder"`
	HighestBid    uint64 `json:"highestBid"`
	Open          bool   `json:"open"`
	Exists        bool   `json:"exists"`
}

func (a *AuctionLogic) CreateAuction(ctx contractapi.TransactionContextInterface, id string, seller string, minPrice uint64) error {
	existing, err := a.getAuction(ctx, id)
	if err != nil {
		return err
	}
	if existing.Exists {
		return fmt.Errorf("AuctionExists")
	}
	if minPrice == 0 {
		return fmt.Errorf("ZeroMinPrice")
	}
	return a.putAuction(ctx, id, &auctionState{
		Seller: seller,
		MinPrice: minPrice,
		Open: true,
		Exists: true,
	})
}

func (a *AuctionLogic) Bid(ctx contractapi.TransactionContextInterface, id string, bidder string, amount uint64) error {
	auction, err := a.getAuction(ctx, id)
	if err != nil {
		return err
	}
	if !auction.Exists {
		return fmt.Errorf("MissingAuction")
	}
	if !auction.Open {
		return fmt.Errorf("Closed")
	}
	if amount < auction.MinPrice || amount <= auction.HighestBid {
		return fmt.Errorf("BidTooLow")
	}
	if auction.HighestBid > 0 {
		if err := addPending(ctx, auction.HighestBidder, auction.HighestBid); err != nil {
			return err
		}
	}
	auction.HighestBidder = bidder
	auction.HighestBid = amount
	return a.putAuction(ctx, id, auction)
}

func (a *AuctionLogic) Close(ctx contractapi.TransactionContextInterface, id string) error {
	auction, err := a.getAuction(ctx, id)
	if err != nil {
		return err
	}
	if !auction.Exists {
		return fmt.Errorf("MissingAuction")
	}
	if !auction.Open {
		return fmt.Errorf("Closed")
	}
	auction.Open = false
	if auction.HighestBid > 0 {
		if err := addPending(ctx, auction.Seller, auction.HighestBid); err != nil {
			return err
		}
	}
	return a.putAuction(ctx, id, auction)
}

func (a *AuctionLogic) Withdraw(ctx contractapi.TransactionContextInterface, user string) (uint64, error) {
	amount, err := pending(ctx, user)
	if err != nil {
		return 0, err
	}
	return amount, ctx.GetStub().PutState(fmt.Sprintf(keyPending, user), []byte("0"))
}

func (a *AuctionLogic) GetAuction(ctx contractapi.TransactionContextInterface, id string) (*auctionState, error) {
	auction, err := a.getAuction(ctx, id)
	if err != nil {
		return nil, err
	}
	return auction, nil
}

func (a *AuctionLogic) PendingReturn(ctx contractapi.TransactionContextInterface, user string) (uint64, error) {
	return pending(ctx, user)
}

func (a *AuctionLogic) ResetAuction(ctx contractapi.TransactionContextInterface, id string) error {
	return ctx.GetStub().DelState(fmt.Sprintf(keyAuction, id))
}

func (a *AuctionLogic) ResetPending(ctx contractapi.TransactionContextInterface, user string) error {
	return ctx.GetStub().PutState(fmt.Sprintf(keyPending, user), []byte("0"))
}

func (a *AuctionLogic) getAuction(ctx contractapi.TransactionContextInterface, id string) (*auctionState, error) {
	raw, err := ctx.GetStub().GetState(fmt.Sprintf(keyAuction, id))
	if err != nil || raw == nil {
		return &auctionState{}, err
	}
	var out auctionState
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (a *AuctionLogic) putAuction(ctx contractapi.TransactionContextInterface, id string, value *auctionState) error {
	raw, _ := json.Marshal(value)
	return ctx.GetStub().PutState(fmt.Sprintf(keyAuction, id), raw)
}

func pending(ctx contractapi.TransactionContextInterface, user string) (uint64, error) {
	raw, err := ctx.GetStub().GetState(fmt.Sprintf(keyPending, user))
	if err != nil || raw == nil {
		return 0, err
	}
	return strconv.ParseUint(string(raw), 10, 64)
}

func addPending(ctx contractapi.TransactionContextInterface, user string, amount uint64) error {
	current, _ := pending(ctx, user)
	return ctx.GetStub().PutState(fmt.Sprintf(keyPending, user), []byte(strconv.FormatUint(current+amount, 10)))
}
