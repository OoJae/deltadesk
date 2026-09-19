// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Test-only stand-in for a Chainlink proxy on the anvil fork (agent e2e). Its runtime code is
/// installed over the real proxy address with anvil_setCode, so the lane's fence and the agent's sensor
/// read it exactly where they read Chainlink. `answer` (slot 0) and `decimals` (slot 1) are set with
/// anvil_setStorageAt; every round is as fresh as the block, so a warp can never kill the feed.
contract MockFeed {
    int256 public answer;
    uint8 public decimals;

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}
