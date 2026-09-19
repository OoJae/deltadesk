// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {DeskHandler} from "./DeskHandler.sol";

/// @notice Every DeskHandler check at once (for scripted runs such as ForkFiftyReranges and the canary tests; the
/// campaigns use DeskInvariantBase instead).
abstract contract DeskChecks is Test {
    function _assertAllChecks(DeskHandler h) internal {
        for (uint8 i = 1; i < 15; ++i) {
            assertEq(h.violations(i), 0, h.firstViolation(i));
        }
        _ok(h.checkI3);
        _ok(h.checkI4);
        _ok(h.checkI5);
        _ok(h.checkI6);
        _ok(h.checkI7);
        _ok(h.checkI8);
        _ok(h.checkI12);
        _ok(h.checkI14);
        (bool live, uint256 gasUsed) = h.exitLiveness();
        assertTrue(live, "I9: exitAll reverted");
        assertLt(gasUsed, 3_000_000, "I9: exitAll gas");
    }

    function _ok(function() external view returns (bool, string memory) check) internal view {
        (bool ok, string memory why) = check();
        assertTrue(ok, why);
    }
}
