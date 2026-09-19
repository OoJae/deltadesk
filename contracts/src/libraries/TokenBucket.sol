// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Linear-refill token bucket, timestamps only.
/// @notice level(t) = min(cap, level(t0) + cap * (t - t0) / period). Levels are kept in WAD-scaled units so that
/// frequent updates do not drop fractional refill (at most 1e-18 unit per update is lost, always against the
/// spender). Buckets start full. A cap change applies on the next read: the level is clamped to the new cap.
library TokenBucket {
    uint256 internal constant WAD = 1e18;

    struct Bucket {
        uint192 levelWad;
        uint64 lastTs;
    }

    /// @notice The refilled level at `nowTs`, in WAD units. Caps are uint64 fields, so cap * WAD < 2^128.
    function availableWad(Bucket memory b, uint256 cap, uint256 period, uint256 nowTs) internal pure returns (uint256) {
        uint256 capWad = cap * WAD;
        uint256 level = b.levelWad;
        if (nowTs > b.lastTs) {
            uint256 dt = nowTs - b.lastTs;
            if (dt >= period) return capWad; // also bounds cap * dt below
            level += capWad * dt / period;
        }
        return level < capWad ? level : capWad;
    }

    /// @notice The refilled level at `nowTs`, in whole units (floored).
    function available(Bucket memory b, uint256 cap, uint256 period, uint256 nowTs) internal pure returns (uint256) {
        return availableWad(b, cap, period, nowTs) / WAD;
    }

    /// @notice Take `amount` whole units at `nowTs`. On failure nothing changes and `have` is the floored level.
    function consume(Bucket storage b, uint256 cap, uint256 period, uint256 amount, uint256 nowTs)
        internal
        returns (bool ok, uint256 have)
    {
        uint256 levelWad = availableWad(b, cap, period, nowTs);
        uint256 needWad = amount * WAD;
        have = levelWad / WAD;
        if (needWad > levelWad) return (false, have);
        b.levelWad = uint192(levelWad - needWad);
        b.lastTs = uint64(nowTs);
        return (true, have);
    }

    /// @notice Set the bucket full at `nowTs`.
    function fill(Bucket storage b, uint256 cap, uint256 nowTs) internal {
        b.levelWad = uint192(cap * WAD);
        b.lastTs = uint64(nowTs);
    }
}
