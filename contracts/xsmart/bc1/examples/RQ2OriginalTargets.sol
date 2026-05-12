// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract TokenTransferOriginal {
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

    function BalanceOf(string memory user) external view returns (uint256) {
        return balances[user];
    }

    function Allowance(string memory owner, string memory spender) external view returns (uint256) {
        return allowances[allowanceKey(owner, spender)];
    }

    function TotalSupply() external view returns (uint256) {
        return totalSupply;
    }

    function allowanceKey(string memory owner, string memory spender) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner, "\x00", spender));
    }
}
