// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ChainlinkFence} from "../src/ChainlinkFence.sol";
import {IDeskTypes} from "../src/interfaces/IDeskTypes.sol";
import {Addresses4663} from "./Addresses4663.sol";

/// @notice M2 configuration shared by the scripts and the tests (docs/m2-design-contracts.md).
library DeskDefaults {
    uint8 internal constant KIND_V3_LP = 1;
    uint8 internal constant LANE_A = 0;
    uint32 internal constant FEED_MAX_AGE = 26 hours;

    /// @notice Default caps of lane A (first live mint about $50).
    function laneCaps() internal pure returns (IDeskTypes.Caps memory) {
        return IDeskTypes.Caps({
            maxDeployUsd6: 60e6,
            turnoverUsd6PerDay: 150e6,
            placeBandBps: 100,
            maxTickDelta: 10,
            minWidthTicks: 20,
            maxWidthTicks: 2000,
            reranges1h: 4,
            reranges24h: 24,
            minRerangeInterval: 300,
            maxDeadlineAhead: 120,
            maxRanges: 2
        });
    }

    /// @notice Factory ceilings. minWidthTicks and minRerangeInterval are LOWER bounds; every other field is an upper
    /// bound (see DeskLaneFactory.setCeilings).
    function ceilings() internal pure returns (IDeskTypes.Caps memory) {
        return IDeskTypes.Caps({
            maxDeployUsd6: 5_000e6,
            turnoverUsd6PerDay: 20_000e6,
            placeBandBps: 300,
            maxTickDelta: 60,
            minWidthTicks: 2,
            maxWidthTicks: 20_000,
            reranges1h: 12,
            reranges24h: 96,
            minRerangeInterval: 60,
            maxDeadlineAhead: 300,
            maxRanges: 2
        });
    }

    /// @notice The Robinhood Chain (4663) fence table: USDG (STABLE), NVDA, SPY, QQQ and TSLA (STOCK), max age 26 h.
    function fenceConfigs4663() internal pure returns (ChainlinkFence.TokenConfig[] memory c) {
        c = new ChainlinkFence.TokenConfig[](5);
        c[0] = _cfg(Addresses4663.USDG, Addresses4663.CL_USDG_USD, ChainlinkFence.Kind.STABLE);
        c[1] = _cfg(Addresses4663.NVDA, Addresses4663.CL_NVDA_USD, ChainlinkFence.Kind.STOCK);
        c[2] = _cfg(Addresses4663.SPY, Addresses4663.CL_SPY_USD, ChainlinkFence.Kind.STOCK);
        c[3] = _cfg(Addresses4663.QQQ, Addresses4663.CL_QQQ_USD, ChainlinkFence.Kind.STOCK);
        c[4] = _cfg(Addresses4663.TSLA, Addresses4663.CL_TSLA_USD, ChainlinkFence.Kind.STOCK);
    }

    function _cfg(address token, address feed, ChainlinkFence.Kind kind)
        private
        pure
        returns (ChainlinkFence.TokenConfig memory)
    {
        return ChainlinkFence.TokenConfig({token: token, feed: feed, kind: kind, maxAge: FEED_MAX_AGE});
    }
}
