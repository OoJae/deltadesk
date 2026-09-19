// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PriceMath} from "../../src/libraries/PriceMath.sol";
import {DeskFixture} from "../utils/DeskFixture.sol";
import {MockToken} from "../utils/MockToken.sol";
import {DeskChecks} from "./DeskChecks.sol";
import {DeskEnv, ForkDeskEnv} from "./DeskEnv.sol";
import {DeskHandler} from "./DeskHandler.sol";

/// @notice Runs the fork-mode harness (ForkDeskEnv: feeds, ERC-8056 flags and token pauses answered by vm.mockCall,
/// funding by raw balance-slot writes; handler in fork mode) on the local fixture, so the code the fork campaign
/// depends on is exercised without an RPC. The mock tokens are plain OZ ERC20s: balances at slot 0.
contract ForkEnvAdapterTest is DeskFixture, DeskChecks {
    DeskHandler internal h;
    ForkDeskEnv internal env;

    function setUp() public override {
        super.setUp();
        env = new ForkDeskEnv(address(usdg), address(nvda), address(usdgFeed), address(nvdaFeed), 1, [uint256(0), 0]);
        address decoy = v3Factory.createPool(USDG_ADDR, NVDA_ADDR, 3000);
        (uint256 sqrtP,) = PriceMath.sqrtPriceX96(1e18, 222.6e18, 6, 18);
        (bool ok,) = decoy.call(abi.encodeWithSignature("initialize(uint160)", uint160(sqrtP)));
        require(ok);
        h = new DeskHandler(
            DeskHandler.Wiring({
                lane: lane,
                npm: npm,
                pool: pool,
                mover: mover,
                env: DeskEnv(env),
                owner: owner,
                operator: operator,
                operator2: makeAddr("operator2"),
                guardian: guardian,
                guardian2: makeAddr("guardian2"),
                attacker: makeAddr("attacker"),
                junk: address(new MockToken("Junk", "JNK", 18)),
                decoyPool: decoy,
                fork: true
            })
        );
        h.start();
    }

    /// @dev The mocks really drive the fence, and a mocked pause really stops transfers.
    function test_mocksDriveFenceAndTokens() public {
        env.setOraclePaused(true);
        assertEq(fence.status(address(nvda)), 3);
        env.setOraclePaused(false);
        env.setReverting(1, true);
        assertEq(fence.status(address(nvda)), 7);
        env.heal(1);
        env.setDecimals(1, 18);
        (uint256 p,, uint8 code) = fence.usdPrice(address(nvda));
        assertEq(code, 0);
        assertEq(p, 222.6e18);
        env.setTokenPaused(0, true);
        vm.prank(address(lane));
        (bool ok,) = address(usdg).call(abi.encodeWithSignature("transfer(address,uint256)", owner, 1));
        assertFalse(ok, "paused by mock");
        env.setTokenPaused(0, false);
        env.fund(address(usdg), owner, 5e6);
        assertEq(usdg.balanceOf(owner), 5e6);
    }

    function test_forkModeHandlerRun() public {
        for (uint256 i; i < 300; ++i) {
            uint256 seed = uint256(keccak256(abi.encode("fork-mode", i)));
            uint256 f = seed % 11;
            uint256 s = seed >> 8;
            if (f == 0) h.honestRerange(s);
            else if (f == 1) h.honestReduce(s);
            else if (f == 2) h.evilRerange(s);
            else if (f == 3) h.evilCall(s, s >> 8, abi.encode(s));
            else if (f == 4) h.attackerAct(s, "");
            else if (f == 5) h.ownerAct(s);
            else if (f == 6) h.guardianAct(s);
            else if (f == 7) h.warp(s);
            else if (f == 8) h.movePrice(s);
            else if (f == 9) h.oracleAct(s);
            else h.tokenAct(s);
            if (i % 30 == 0) _assertAllChecks(h);
        }
        _assertAllChecks(h);
        assertGt(h.riskReranges(), 0);
        assertEq(bytes(h.ownerCanAlwaysExit()).length, 0, "I2");
    }
}
