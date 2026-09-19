// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Settable Chainlink feed: answer, updatedAt, decimals and a revert toggle.
contract MockAggregator {
    uint8 private _decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId;
    bool public reverting;

    constructor(uint8 decimals_, int256 answer_) {
        _decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
        roundId = 1;
    }

    function decimals() external view returns (uint8) {
        if (reverting) revert("MockAggregator: reverting");
        return _decimals;
    }

    function description() external pure returns (string memory) {
        return "mock";
    }

    function version() external pure returns (uint256) {
        return 4;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        if (reverting) revert("MockAggregator: reverting");
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }

    /// @notice New round with `answer_` at the current block time.
    function setAnswer(int256 answer_) external {
        set(answer_, block.timestamp);
    }

    function set(int256 answer_, uint256 updatedAt_) public {
        answer = answer_;
        updatedAt = updatedAt_;
        roundId++;
    }

    function setUpdatedAt(uint256 updatedAt_) external {
        updatedAt = updatedAt_;
    }

    /// @notice Change the feed decimals, rescaling the stored answer so the price is unchanged.
    function setDecimalsKeepPrice(uint8 decimals_) external {
        if (decimals_ > _decimals) answer *= int256(10 ** (decimals_ - _decimals));
        else answer /= int256(10 ** (_decimals - decimals_));
        _decimals = decimals_;
    }

    function setDecimals(uint8 decimals_) external {
        _decimals = decimals_;
    }

    function setReverting(bool r) external {
        reverting = r;
    }
}
