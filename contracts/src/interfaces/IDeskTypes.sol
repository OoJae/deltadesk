// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Shared types of DeltaDesk lanes (FROZEN interface, M2).
/// @notice A lane is one EIP-1167 clone that provides liquidity in ONE Uniswap v3 pool on behalf of ONE owner.
/// Money units: "usd6" = US dollars with 6 decimals, valued at the lane's price fence (see IPriceFence).
interface IDeskTypes {
    /// @notice What a LaneAction log records. Append-only: never reorder (the agent decodes by index).
    enum Action {
        RERANGE, // unwind all positions, mint new ranges (risk-adding)
        REDUCE, // remove liquidity from one position (risk-reducing)
        COLLECT, // collect fees of all positions (risk-reducing)
        EXIT_ALL, // unwind every position to idle tokens (risk-reducing)
        WITHDRAW, // owner withdrew tokens (owner-only)
        WITHDRAW_POSITION, // owner took a position NFT out (escape hatch)
        PAUSE,
        UNPAUSE,
        SIGNAL, // event-only log (e.g. an off-chain gate changed)
        SET_OPERATOR,
        SET_CAPS,
        SET_CLOSED_UNTIL,
        SET_GUARDIAN
    }

    /// @notice Attached to every mutating operator call.
    /// @param decisionId Agent decision id (ULID-derived, nonzero). Single-use across ALL functions of a lane.
    /// @param deadline Unix seconds. Must satisfy block.timestamp <= deadline <= block.timestamp + caps.maxDeadlineAhead.
    /// @param regime Off-chain regime code (logged only, untrusted).
    /// @param gatesMask Off-chain gate bitmask (logged only, untrusted).
    /// @param reasonHash keccak256 of the agent's published decision preimage (logged only, untrusted).
    struct Meta {
        bytes32 decisionId;
        uint64 deadline;
        uint8 regime;
        uint16 gatesMask;
        bytes32 reasonHash;
    }

    /// @notice One range to mint in a rerange. Amounts are shares (bps, 0..10_000) of the lane's idle balances AFTER
    /// the unwind; the sum over ranges of share0Bps (and of share1Bps) must be <= 10_000.
    struct RangeSpec {
        int24 tickLower;
        int24 tickUpper;
        uint16 share0Bps;
        uint16 share1Bps;
    }

    /// @notice Per-lane limits. Loosening any field is timelocked (24 h); tightening applies immediately.
    /// "Tighter" means: smaller for every max/limit/count/band/width-max, larger for minRerangeInterval and
    /// minWidthTicks, and smaller maxDeadlineAhead.
    struct Caps {
        uint64 maxDeployUsd6; // max fence-valued notional minted by one rerange
        uint64 turnoverUsd6PerDay; // token bucket of minted notional; refills linearly over 24 h
        uint16 placeBandBps; // delta: placement fence half-width around the fence reference price (in bps ~ ticks)
        uint24 maxTickDelta; // ceiling for |slot0.tick - expectedTick| at execution
        uint24 minWidthTicks; // tickUpper - tickLower >= this
        uint24 maxWidthTicks; // tickUpper - tickLower <= this
        uint16 reranges1h; // rolling-window budget (token bucket, 1 h period)
        uint16 reranges24h; // rolling-window budget (token bucket, 24 h period)
        uint32 minRerangeInterval; // seconds between reranges
        uint32 maxDeadlineAhead; // seconds, e.g. 120
        uint8 maxRanges; // live positions and ranges per rerange (<= 2 in M2)
    }
}
