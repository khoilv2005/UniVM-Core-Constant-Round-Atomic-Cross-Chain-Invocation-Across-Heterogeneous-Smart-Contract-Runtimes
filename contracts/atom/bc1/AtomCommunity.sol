// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract AtomCommunity is Ownable {
    mapping(address => bool) public activeServers;
    mapping(address => bool) public activeJudges;

    address[] private _servers;
    address[] private _judges;

    event ServerRegistered(address indexed server, bool active);
    event JudgeRegistered(address indexed judge, bool active);
    event JudgesSelected(bytes32 indexed invokeId, address[] judges);

    constructor() Ownable(msg.sender) {}

    function registerServer(address server) external onlyOwner {
        require(server != address(0), "Zero server");
        if (!activeServers[server]) {
            activeServers[server] = true;
            _servers.push(server);
        }
        emit ServerRegistered(server, true);
    }

    function registerJudge(address judge) external onlyOwner {
        require(judge != address(0), "Zero judge");
        if (!activeJudges[judge]) {
            activeJudges[judge] = true;
            _judges.push(judge);
        }
        emit JudgeRegistered(judge, true);
    }

    function disableServer(address server) external onlyOwner {
        activeServers[server] = false;
        emit ServerRegistered(server, false);
    }

    function disableJudge(address judge) external onlyOwner {
        activeJudges[judge] = false;
        emit JudgeRegistered(judge, false);
    }

    function getActiveJudges() external view returns (address[] memory judges) {
        uint256 count;
        uint256 len = _judges.length;
        for (uint256 i = 0; i < len; i++) {
            if (activeJudges[_judges[i]]) {
                count++;
            }
        }

        judges = new address[](count);
        uint256 idx;
        for (uint256 i = 0; i < len; i++) {
            if (activeJudges[_judges[i]]) {
                judges[idx++] = _judges[i];
            }
        }
    }

    function selectJudges(bytes32 invokeId, uint256 judgeNumNeed) external view returns (address[] memory selected) {
        require(judgeNumNeed > 0, "Zero judge count");

        address[] memory judges = this.getActiveJudges();
        uint256 judgeCount = judges.length;
        require(judgeCount >= judgeNumNeed, "Not enough judges");

        selected = new address[](judgeNumNeed);
        bool[] memory used = new bool[](judgeCount);
        bytes32 seed = keccak256(abi.encodePacked(invokeId, blockhash(block.number - 1), block.prevrandao, block.timestamp, msg.sender, address(this)));

        for (uint256 i = 0; i < judgeNumNeed; i++) {
            uint256 candidate = uint256(seed) % judgeCount;
            while (used[candidate]) {
                seed = keccak256(abi.encodePacked(seed, i, candidate));
                candidate = uint256(seed) % judgeCount;
            }

            used[candidate] = true;
            selected[i] = judges[candidate];
            seed = keccak256(abi.encodePacked(seed, selected[i], i));
        }
    }
}

