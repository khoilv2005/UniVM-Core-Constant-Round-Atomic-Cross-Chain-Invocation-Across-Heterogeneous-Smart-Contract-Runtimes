// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract TrainBookingTranslated {
    struct LockEntry {
        uint256 lockedAmount;
        bool active;
    }

    string private bridge;
    uint256 private price;
    uint256 private remain;
    uint256 private lockSize;
    uint256 private lockedTotal;
    mapping(string => uint256) private accounts;
    mapping(string => uint256) private bookings;
    mapping(string => LockEntry) private locks;

    constructor(string memory bridge_, uint256 price_, uint256 remain_, uint256 lockSize_) {
        require(price_ > 0, "price must be > 0");
        bridge = bridge_;
        price = price_;
        remain = remain_;
        lockSize = lockSize_ == 0 ? 1 : lockSize_;
    }

    function Rq2Reset(string memory bridge_, uint256 price_, uint256 remain_, uint256 lockSize_) external {
        require(price_ > 0, "price must be > 0");
        bridge = bridge_;
        price = price_;
        remain = remain_;
        lockSize = lockSize_ == 0 ? 1 : lockSize_;
        lockedTotal = 0;
    }

    function GetPrice() external view returns (uint256) { return price; }
    function GetRemain() external view returns (uint256) { return remain; }
    function GetLockedTotal() external view returns (uint256) { return lockedTotal; }
    function GetAccountBalance(string memory user) external view returns (uint256) { return accounts[user]; }
    function GetBooking(string memory user) external view returns (uint256) { return bookings[user]; }
    function IsStateLocked(string memory lockId) external view returns (bool) { return locks[lockId].active; }
    function GetLockAmount(string memory lockId) external view returns (uint256) { return locks[lockId].lockedAmount; }

    function GetAvailableRemain() public view returns (uint256) {
        uint256 lockedUnits = lockedTotal / price;
        return remain > lockedUnits ? remain - lockedUnits : 0;
    }

    function BookLocal(string memory user, uint256 amount) external returns (uint256) {
        require(amount > 0, "ZeroAmount");
        require(GetAvailableRemain() >= amount, "InsufficientRemain");
        uint256 cost = price * amount;
        remain -= amount;
        accounts[user] += cost;
        bookings[user] += amount;
        return cost;
    }

    function LockState(string memory lockId, uint256 amount, uint256) external returns (uint256, uint256) {
        require(!locks[lockId].active, "AlreadyLocked");
        require(GetAvailableRemain() >= amount, "InsufficientRemain");
        uint256 lockedAmount = (amount > 0 ? amount : lockSize) * price;
        locks[lockId] = LockEntry({lockedAmount: lockedAmount, active: true});
        lockedTotal += lockedAmount;
        return (price, remain);
    }

    function UnlockState(string memory lockId) external {
        require(locks[lockId].active, "NotLocked");
        uint256 amount = locks[lockId].lockedAmount;
        lockedTotal = lockedTotal > amount ? lockedTotal - amount : 0;
        delete locks[lockId];
    }

    function GetBridge() external view returns (string memory) { return bridge; }
    function GetLockSize() external view returns (uint256) { return lockSize; }
}

contract TokenTransferTranslated {
    mapping(string => uint256) private balances;
    mapping(bytes32 => uint256) private allowances;
    uint256 private totalSupply;

    function Rq2Reset() external {
        totalSupply = 0;
    }

    function Mint(string memory to, uint256 amount) external {
        require(amount > 0, "ZeroAmount");
        balances[to] += amount;
        totalSupply += amount;
    }

    function Transfer(string memory from, string memory to, uint256 amount) external {
        require(balances[from] >= amount, "InsufficientBalance");
        balances[from] -= amount;
        balances[to] += amount;
    }

    function Approve(string memory owner, string memory spender, uint256 amount) external {
        allowances[allowanceKey(owner, spender)] = amount;
    }

    function TransferFrom(string memory spender, string memory from, string memory to, uint256 amount) external {
        bytes32 key = allowanceKey(from, spender);
        require(allowances[key] >= amount, "InsufficientAllowance");
        require(balances[from] >= amount, "InsufficientBalance");
        allowances[key] -= amount;
        balances[from] -= amount;
        balances[to] += amount;
    }

    function BalanceOf(string memory user) external view returns (uint256) { return balances[user]; }
    function Allowance(string memory owner, string memory spender) external view returns (uint256) {
        return allowances[allowanceKey(owner, spender)];
    }
    function TotalSupply() external view returns (uint256) { return totalSupply; }

    function allowanceKey(string memory owner, string memory spender) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner, "\x00", spender));
    }
}

contract AuctionLogicTranslated {
    struct Auction {
        string seller;
        uint256 minPrice;
        string highestBidder;
        uint256 highestBid;
        bool open;
        bool exists;
    }

    mapping(uint256 => Auction) private auctions;
    mapping(string => uint256) private pendingReturns;

    function CreateAuction(uint256 id, string memory seller, uint256 minPrice) external {
        require(!auctions[id].exists, "AuctionExists");
        require(minPrice > 0, "ZeroMinPrice");
        auctions[id] = Auction({
            seller: seller,
            minPrice: minPrice,
            highestBidder: "",
            highestBid: 0,
            open: true,
            exists: true
        });
    }

    function Bid(uint256 id, string memory bidder, uint256 amount) external {
        Auction storage a = auctions[id];
        require(a.exists, "MissingAuction");
        require(a.open, "Closed");
        require(amount >= a.minPrice && amount > a.highestBid, "BidTooLow");
        if (a.highestBid > 0) {
            pendingReturns[a.highestBidder] += a.highestBid;
        }
        a.highestBidder = bidder;
        a.highestBid = amount;
    }

    function Close(uint256 id) external {
        Auction storage a = auctions[id];
        require(a.exists, "MissingAuction");
        require(a.open, "Closed");
        a.open = false;
        if (a.highestBid > 0) {
            pendingReturns[a.seller] += a.highestBid;
        }
    }

    function Withdraw(string memory user) external returns (uint256) {
        uint256 amount = pendingReturns[user];
        pendingReturns[user] = 0;
        return amount;
    }

    function GetAuction(uint256 id) external view returns (string memory, uint256, string memory, uint256, bool, bool) {
        Auction storage a = auctions[id];
        return (a.seller, a.minPrice, a.highestBidder, a.highestBid, a.open, a.exists);
    }

    function PendingReturn(string memory user) external view returns (uint256) {
        return pendingReturns[user];
    }
}

contract DEXSwapTranslated {
    uint256 private reserveA;
    uint256 private reserveB;
    uint256 private totalShares;
    mapping(string => uint256) private shares;

    function Rq2Reset() external {
        reserveA = 0;
        reserveB = 0;
        totalShares = 0;
    }

    function AddLiquidity(string memory user, uint256 amountA, uint256 amountB) external returns (uint256) {
        require(amountA > 0 && amountB > 0, "ZeroLiquidity");
        uint256 minted;
        if (totalShares == 0) {
            minted = amountA + amountB;
        } else {
            uint256 shareA = (amountA * totalShares) / reserveA;
            uint256 shareB = (amountB * totalShares) / reserveB;
            minted = shareA < shareB ? shareA : shareB;
        }
        require(minted > 0, "ZeroShares");
        reserveA += amountA;
        reserveB += amountB;
        totalShares += minted;
        shares[user] += minted;
        return minted;
    }

    function RemoveLiquidity(string memory user, uint256 shareAmount) external returns (uint256, uint256) {
        require(shareAmount > 0, "ZeroShares");
        require(shares[user] >= shareAmount, "InsufficientShares");
        uint256 amountA = (reserveA * shareAmount) / totalShares;
        uint256 amountB = (reserveB * shareAmount) / totalShares;
        shares[user] -= shareAmount;
        totalShares -= shareAmount;
        reserveA -= amountA;
        reserveB -= amountB;
        return (amountA, amountB);
    }

    function SwapAForB(string memory, uint256 amountIn) external returns (uint256) {
        require(amountIn > 0, "ZeroInput");
        require(reserveA > 0 && reserveB > 0, "InsufficientLiquidity");
        uint256 amountInWithFee = amountIn * 997;
        uint256 amountOut = (amountInWithFee * reserveB) / (reserveA * 1000 + amountInWithFee);
        require(amountOut > 0 && amountOut < reserveB, "InsufficientOutput");
        reserveA += amountIn;
        reserveB -= amountOut;
        return amountOut;
    }

    function GetReserves() external view returns (uint256, uint256) { return (reserveA, reserveB); }
    function GetShares(string memory user) external view returns (uint256) { return shares[user]; }
    function TotalShares() external view returns (uint256) { return totalShares; }
}
