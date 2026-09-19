// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PriceMath} from "../../src/libraries/PriceMath.sol";
import {DeskFixture} from "../utils/DeskFixture.sol";
import {MockToken} from "../utils/MockToken.sol";
import {DeskEnv, LocalDeskEnv} from "./DeskEnv.sol";
import {DeskHandler} from "./DeskHandler.sol";

/// @notice The M2 fixture (real Uniswap v3 factory + NPM, mock USDG/NVDA, mock feeds, the default lane A caps and ~$50
/// of funds) wired to a DeskHandler. A decoy pool (same tokens, fee 3000) is where the attacker mints foreign
/// positions for the lane.
abstract contract LocalHandlerSetup is DeskFixture {
    function _localHandler() internal returns (DeskHandler h) {
        address decoy = v3Factory.createPool(USDG_ADDR, NVDA_ADDR, 3000);
        (uint256 sqrtP,) = PriceMath.sqrtPriceX96(1e18, 222.6e18, 6, 18);
        (bool ok,) = decoy.call(abi.encodeWithSignature("initialize(uint160)", uint160(sqrtP)));
        require(ok, "decoy init");
        MockToken junk = new MockToken("Junk", "JNK", 18);
        DeskEnv env = new LocalDeskEnv(usdg, nvda, usdgFeed, nvdaFeed, 1);
        h = new DeskHandler(
            DeskHandler.Wiring({
                lane: lane,
                npm: npm,
                pool: pool,
                mover: mover,
                env: env,
                owner: owner,
                operator: operator,
                operator2: makeAddr("operator2"),
                guardian: guardian,
                guardian2: makeAddr("guardian2"),
                attacker: makeAddr("attacker"),
                junk: address(junk),
                decoyPool: decoy,
                fork: false
            })
        );
        h.start();
    }
}
