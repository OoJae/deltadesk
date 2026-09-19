// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDeskTypes} from "../../src/interfaces/IDeskTypes.sol";
import {DeskDefaults} from "../../script/DeskDefaults.sol";
import {DeskChecks} from "../invariant/DeskChecks.sol";
import {DeskHandler} from "../invariant/DeskHandler.sol";
import {LaneMath} from "../utils/LaneMath.sol";
import {ForkHandlerSetup} from "./ForkHandlerSetup.sol";

/// @notice At least 50 successful reranges on the real pool, with time moving forward, the market and the attacker
/// moving the pool, and Chainlink steps between them; every invariant check (I1-I14 as in the local campaign, plus exit
/// liveness) runs after each step, and the owner's exit drill (I2) at the end.
/// The lane uses caps within the factory ceilings that allow a rerange a minute (12/h, 96/day, $20k/day turnover);
/// the per-rerange deploy cap stays at the M2 default of $60.
contract ForkFiftyRerangesTest is ForkHandlerSetup, DeskChecks {
    DeskHandler internal h;

    function setUp() public {
        if (!_fork(WEEKDAY_BLOCK)) return;
        IDeskTypes.Caps memory c = DeskDefaults.laneCaps();
        c.turnoverUsd6PerDay = 20_000e6;
        c.reranges1h = 12;
        c.reranges24h = 96;
        c.minRerangeInterval = 60;
        h = _forkHandler(c);
    }

    function test_fiftyReranges() public {
        uint256 steps;
        for (uint256 i; h.riskReranges() < 50 && i < 400; ++i) {
            uint256 seed = uint256(keccak256(abi.encode("fifty", i)));
            uint256 dt = 61 + seed % 540;
            if (LaneMath.stockWeekend(block.timestamp + dt)) dt = _toMonday(block.timestamp + dt) - block.timestamp;
            h.advance(dt, seed);
            if (i % 9 == 4) h.stockStep(int256(seed >> 16) % 101 - 50); // a Chainlink step of up to +-0.5%
            h.movePrice(seed >> 32);
            h.honestRerange(seed >> 64);
            _assertAllChecks(h);
            steps++;
        }
        emit log_named_uint("steps", steps);
        emit log_named_uint("successful risk-adding reranges", h.riskReranges());
        emit log_named_uint("positions minted", h.mints());
        emit log_named_uint("Chainlink steps", h.priceSteps());
        emit log_named_decimal_uint("turnover minted (USD)", h.turnoverUsed(), 6);
        (int256 g, uint256 allowance) = h.boundedLoss();
        emit log_named_decimal_int("fence-valued P&L (USD)", g, 6);
        emit log_named_decimal_uint("I7 allowance (USD)", allowance, 6);
        assertGe(h.riskReranges(), 50, "fewer than 50 reranges");
        assertEq(bytes(h.ownerCanAlwaysExit()).length, 0, "I2");
    }

    function _toMonday(uint256 ts) internal pure returns (uint256) {
        uint256 day = ts / 1 days;
        return (day + (7 - LaneMath.weekdayMon0(ts)) % 7) * 1 days + 2 hours;
    }
}
