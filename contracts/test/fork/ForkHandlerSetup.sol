// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDeskTypes} from "../../src/interfaces/IDeskTypes.sol";
import {IUniswapV3FactoryMin} from "../../src/interfaces/external/IUniswapV3FactoryMin.sol";
import {Addresses4663} from "../../script/Addresses4663.sol";
import {DeskEnv, ForkDeskEnv} from "../invariant/DeskEnv.sol";
import {DeskHandler} from "../invariant/DeskHandler.sol";
import {ForkBase} from "../utils/ForkBase.sol";
import {IUniswapV3PoolTest} from "../utils/IUniswapV3PoolTest.sol";
import {LaneMath} from "../utils/LaneMath.sol";
import {MockToken} from "../utils/MockToken.sol";
import {PoolMover} from "../utils/PoolMover.sol";

/// @notice A DeskHandler on a 4663 fork: the real pool, NPM, USDG and NVDA, with the Chainlink proxies and NVDA's
/// ERC-8056 getters answered through ForkDeskEnv (vm.mockCall, starting from their live values). On a weekend block
/// the clock first moves to Monday 02:00 UTC and the feeds are re-stamped.
abstract contract ForkHandlerSetup is ForkBase {
    ForkDeskEnv internal env;

    function _forkHandler(IDeskTypes.Caps memory caps) internal returns (DeskHandler h) {
        _deployDesk();
        lane = _createLane(caps);
        if (LaneMath.stockWeekend(block.timestamp)) {
            uint256 day = block.timestamp / 1 days;
            uint256 target = (day + (7 - LaneMath.weekdayMon0(block.timestamp)) % 7) * 1 days + 2 hours;
            vm.roll(block.number + (target - block.timestamp) * 10);
            vm.warp(target);
        }
        env = new ForkDeskEnv(
            Addresses4663.USDG,
            Addresses4663.NVDA,
            Addresses4663.CL_USDG_USD,
            Addresses4663.CL_NVDA_USD,
            1,
            [USDG_BALANCES_SLOT, uint256(OZ_ERC20_STORAGE)]
        );
        for (uint8 i; i < 2; ++i) {
            if (block.timestamp - env.feed(i).updatedAt > env.MAX_AGE()) env.setUpdatedAt(i, block.timestamp);
        }
        _fundUsd(address(lane), 25e6);
        mover = new PoolMover(address(POOL));
        MockToken junk = new MockToken("Junk", "JNK", 18);
        h = new DeskHandler(
            DeskHandler.Wiring({
                lane: lane,
                npm: NPM,
                pool: POOL,
                mover: mover,
                env: DeskEnv(env),
                owner: owner,
                operator: operator,
                operator2: makeAddr("operator2"),
                guardian: guardian,
                guardian2: makeAddr("guardian2"),
                attacker: attacker,
                junk: address(junk),
                decoyPool: _decoyPool(),
                fork: true
            })
        );
        h.start();
    }

    /// @dev The USDG/NVDA pool at fee 3000 (created and initialised on the fork if the chain has none).
    function _decoyPool() internal returns (address p) {
        IUniswapV3FactoryMin f = IUniswapV3FactoryMin(Addresses4663.V3_FACTORY);
        p = f.getPool(Addresses4663.USDG, Addresses4663.NVDA, 3000);
        if (p == address(0)) p = f.createPool(Addresses4663.USDG, Addresses4663.NVDA, 3000);
        (uint160 s,,,,,,) = IUniswapV3PoolTest(p).slot0();
        if (s == 0) {
            (uint160 main,,,,,,) = POOL.slot0();
            IUniswapV3PoolTest(p).initialize(main);
        }
    }
}
