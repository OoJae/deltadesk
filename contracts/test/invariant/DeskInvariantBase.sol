// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {DeskHandler} from "./DeskHandler.sol";

/// @notice Invariants I1-I14 of docs/m2-design-contracts.md over a DeskHandler, shared by the local campaign
/// (DeskInvariants.t.sol) and the fork campaign (test/fork/ForkInvariants.t.sol). Findings the handler's log auditor
/// makes mid-call are counters that must stay 0; the rest are checked on the state after every call.
/// Set DESK_INVARIANT_LOG=reports/<file>.jsonl to append each run's counters (see reports/summarize.py).
abstract contract DeskInvariantBase is Test {
    DeskHandler internal handler;

    function _targetHandler(DeskHandler h) internal {
        handler = h;
        h.start();
        bytes4[] memory s = new bytes4[](11);
        s[0] = DeskHandler.honestRerange.selector;
        s[1] = DeskHandler.honestReduce.selector;
        s[2] = DeskHandler.evilRerange.selector;
        s[3] = DeskHandler.evilCall.selector;
        s[4] = DeskHandler.attackerAct.selector;
        s[5] = DeskHandler.ownerAct.selector;
        s[6] = DeskHandler.guardianAct.selector;
        s[7] = DeskHandler.warp.selector;
        s[8] = DeskHandler.movePrice.selector;
        s[9] = DeskHandler.oracleAct.selector;
        s[10] = DeskHandler.tokenAct.selector;
        targetContract(address(h));
        targetSelector(FuzzSelector({addr: address(h), selectors: s}));
    }

    /// I1. Every ERC-20 transfer from the lane goes to the owner (owner withdrawals) or to the lane pool inside an NPM
    /// mint of a position the lane then owns; every NFT leaving the lane goes to the owner or burns.
    function invariant_I1_outflowsOnlyToOwnerOrOwnMints() public view {
        _noFinding(1);
    }

    /// I3. A decisionId is spent at most once, and a reverted call spends nothing.
    function invariant_I3_decisionIdsSpentOnce() public view {
        _noFinding(3);
        _holds(handler.checkI3);
    }

    /// I4. Buckets and the rerange interval match an independent exact model.
    function invariant_I4_budgetsMatchModel() public view {
        _noFinding(4);
        _holds(handler.checkI4);
    }

    /// I5. No allowance from the lane survives a call (and the lane only ever approves the NPM).
    function invariant_I5_noAllowances() public view {
        _noFinding(5);
        _holds(handler.checkI5);
    }

    /// I6. Only the lane pool is ever used for NPM positions.
    function invariant_I6_onlyLanePool() public view {
        _noFinding(6);
        _holds(handler.checkI6);
    }

    /// I7. Bounded loss: fence-valued NAV >= initial - band x turnover used - rounding, with flows, fence price steps
    /// and donated liquidity accounted (see DeskHandler.checkI7).
    function invariant_I7_boundedLoss() public view {
        _noFinding(7);
        _holds(handler.checkI7);
    }

    /// I8. The operator (or anyone but the owner) never changes owner, operator, caps, guardian, never unpauses and
    /// never withdraws; the config always equals the owner-driven model.
    function invariant_I8_rolesAndConfig() public view {
        _noFinding(8);
        _holds(handler.checkI8);
    }

    /// I9. From any reachable state, exitAll succeeds within 3M gas.
    function invariant_I9_exitLiveness() public {
        (bool ok, uint256 gasUsed) = handler.exitLiveness();
        assertTrue(ok, "I9: exitAll reverted");
        assertLt(gasUsed, 3_000_000, "I9: exitAll gas");
    }

    /// I10. The placement fence held for every range at mint time.
    function invariant_I10_placementFence() public view {
        _noFinding(10);
    }

    /// I11. No liquidity is added while paused, while closedUntil is active, or while a fence code is not 0.
    function invariant_I11_noRiskAddingWhileClosed() public view {
        _noFinding(11);
    }

    /// I12. Tracked slots equal the lane-owned NPM positions (attacker-planted NFTs aside), at most 2.
    function invariant_I12_nftBookkeeping() public view {
        _noFinding(12);
        _holds(handler.checkI12);
    }

    /// I13. Every Meta call that succeeded was inside now <= deadline <= now + maxDeadlineAhead. Limits are
    /// timestamp-only: the handler rolls block.number arbitrarily and I4 still holds (CI also greps src/).
    function invariant_I13_deadlineWindow() public view {
        _noFinding(13);
    }

    /// I14. refTick follows the feeds exactly once per step (a uiMultiplier change never moves it by itself), and
    /// the fence codes and riskAddingOpen match the model.
    function invariant_I14_refTickFollowsFeeds() public view {
        _noFinding(14);
        _holds(handler.checkI14);
    }

    /// I2. Exits never need the oracle: with the fence broken and a token paused, the owner still recovers everything
    /// recoverable (then again with everything healthy). Also records the final exitAll gas and the run's counters.
    function afterInvariant() public {
        string memory failure = handler.ownerCanAlwaysExit();
        assertEq(bytes(failure).length, 0, string.concat("I2: ", failure));
        (bool ok, uint256 gasUsed) = handler.exitLiveness();
        assertTrue(ok, "I9: exitAll reverted at the end of the run");
        handler.recordExitGas(gasUsed);
        string memory log = vm.envOr("DESK_INVARIANT_LOG", string(""));
        if (bytes(log).length != 0) vm.writeLine(log, handler.statsJson());
    }

    function _noFinding(uint8 i) internal view {
        assertEq(handler.violations(i), 0, string.concat("I", vm.toString(uint256(i)), ": ", handler.firstViolation(i)));
    }

    function _holds(function() external view returns (bool, string memory) check) internal view {
        (bool ok, string memory why) = check();
        assertTrue(ok, why);
    }
}
