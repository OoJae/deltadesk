// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DeskInvariantBase} from "./DeskInvariantBase.sol";
import {LocalHandlerSetup} from "./LocalHandlerSetup.sol";

/// @notice The local invariant campaign (default profile: 1,000 runs x depth 100, fail_on_revert = false) over the M2
/// fixture, driven by DeskHandler. Run with DESK_INVARIANT_LOG=reports/<file>.jsonl to keep per-run counters.
contract DeskInvariantsTest is LocalHandlerSetup, DeskInvariantBase {
    function setUp() public override {
        super.setUp();
        _targetHandler(_localHandler());
    }
}
