// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Price fence (FROZEN interface, M2).
/// @notice A COARSE catastrophe fence, not a precise oracle. On Robinhood Chain the Chainlink stock feeds update only on
/// a 50 bp deviation or a ~24 h heartbeat and are frozen Fri 20:00 -> Sun 20:00 ET, so the fence is good to roughly
/// +-50 bp during the 24/5 session and says nothing on weekends. Lanes use it (a) to value notional for caps and
/// (b) to anchor the placement fence (with band delta >= ~100 bp). Precise fair value stays off-chain.
/// M2 implementation: ChainlinkFence. M3: SignedMarkOracle implements the same interface with tighter bands.
interface IPriceFence {
    /// @notice Status codes. 0 means usable for RISK-ADDING actions.
    /// 1 UNKNOWN_TOKEN, 2 FEED_DEAD (answer <= 0, updatedAt in the future, or age > maxAge),
    /// 3 ORACLE_PAUSED (ERC-8056 oraclePaused()), 4 CORP_ACTION_WINDOW (within the guard of uiMultiplier effectiveAt),
    /// 5 MARKET_CLOSED (stock tokens: conservative UTC weekend window Sat 00:00 -> Mon 01:00), 6 DEPEG (stable tokens),
    /// 7 FEED_REVERTED.
    function status(address token) external view returns (uint8 code);

    /// @notice USD price of ONE WHOLE token (i.e. 10**decimals base units), scaled 1e18. Reads the feed's decimals live.
    /// Never reverts: returns (0, 0, code) when the feed is unusable. Callers MUST check code == 0 before relying on it
    /// for risk-adding actions; risk-reducing actions must not call the fence at all.
    function usdPrice(address token) external view returns (uint256 priceE18, uint64 updatedAt, uint8 code);
}
