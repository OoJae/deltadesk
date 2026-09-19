// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DeskDefaults} from "../../script/DeskDefaults.sol";
import {DeskInvariantBase} from "../invariant/DeskInvariantBase.sol";
import {ForkHandlerSetup} from "./ForkHandlerSetup.sol";

/// @notice The invariant campaign (I1-I14, FOUNDRY_PROFILE=fork: 50 runs x depth 20) on a 4663 fork with the M2
/// default caps: the same DeskHandler as the local campaign, against the real pool, NPM and tokens.
contract ForkInvariantsTest is ForkHandlerSetup, DeskInvariantBase {
    function setUp() public {
        if (!_fork(WEEKDAY_BLOCK)) return;
        _targetHandler(_forkHandler(DeskDefaults.laneCaps()));
    }
}
