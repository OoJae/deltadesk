// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice ERC-8056 scaled-UI-amount surface of Robinhood Chain stock tokens, as read by ChainlinkFence.
/// One token represents `uiMultiplier` shares; a corporate action schedules `newUIMultiplier` at `effectiveAt`.
/// `oraclePaused` is set by the issuer while the token's price oracle is suspended (e.g. around a corporate action).
/// Verified on NVDA/SPY/QQQ/TSLA (4663) with read-only calls on 2026-09-19.
interface IERC8056 {
    function uiMultiplier() external view returns (uint256);
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
    function oraclePaused() external view returns (bool);
}
