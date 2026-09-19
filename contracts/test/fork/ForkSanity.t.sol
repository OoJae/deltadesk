// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {ChainlinkFence} from "../../src/ChainlinkFence.sol";
import {IDeskLane} from "../../src/interfaces/IDeskLane.sol";
import {IDeskTypes} from "../../src/interfaces/IDeskTypes.sol";
import {AggregatorV3Interface} from "../../src/interfaces/external/AggregatorV3Interface.sol";
import {IUniswapV3FactoryMin} from "../../src/interfaces/external/IUniswapV3FactoryMin.sol";
import {Addresses4663} from "../../script/Addresses4663.sol";
import {DeskDefaults} from "../../script/DeskDefaults.sol";
import {ForkBase} from "../utils/ForkBase.sol";
import {LaneMath} from "../utils/LaneMath.sol";

/// @dev A fresh contract that holds tokens and sends them on (NVDA must not be restricted to allowlisted holders).
contract Holder {
    function send(IERC20 token, address to, uint256 amount) external {
        require(token.transfer(to, amount), "transfer");
    }
}

/// @notice The 4663 facts the desk depends on, at the pinned weekday block (FORK_BLOCK overrides; "latest" works on
/// the public RPC): addresses and code, pool shape, feeds and fence codes, funding by deal and by raw storage, a fresh
/// contract holding and sending NVDA, and the real Deploy script. Skipped without RH_ARCHIVE_RPC.
contract ForkSanityTest is ForkBase {
    function setUp() public {
        if (!_fork(WEEKDAY_BLOCK)) return;
        _deployDesk();
    }

    function test_addressesAndCode() public view {
        address[12] memory a = [
            Addresses4663.V3_FACTORY,
            Addresses4663.NPM,
            Addresses4663.SWAP_ROUTER_02,
            Addresses4663.QUOTER_V2,
            Addresses4663.WETH9,
            Addresses4663.POOL_NVDA_USDG,
            Addresses4663.USDG,
            Addresses4663.NVDA,
            Addresses4663.CL_NVDA_USD,
            Addresses4663.CL_USDG_USD,
            Addresses4663.MULTICALL3,
            Addresses4663.PERMIT2
        ];
        for (uint256 i; i < a.length; ++i) {
            assertGt(a[i].code.length, 0, vm.toString(a[i]));
        }
        assertEq(POOL.token0(), Addresses4663.USDG);
        assertEq(POOL.token1(), Addresses4663.NVDA);
        assertEq(POOL.fee(), 500);
        assertEq(POOL.tickSpacing(), 10);
        assertEq(POOL.factory(), Addresses4663.V3_FACTORY);
        assertEq(
            IUniswapV3FactoryMin(Addresses4663.V3_FACTORY).getPool(Addresses4663.USDG, Addresses4663.NVDA, 500),
            Addresses4663.POOL_NVDA_USDG
        );
        assertEq(NPM.factory(), Addresses4663.V3_FACTORY);
        assertEq(NPM.WETH9(), Addresses4663.WETH9);
        assertEq(IERC20Metadata(Addresses4663.USDG).decimals(), 6);
        assertEq(IERC20Metadata(Addresses4663.NVDA).decimals(), 18);
        assertGt(POOL.liquidity(), 0, "the pool has in-range liquidity");
    }

    /// @dev Feeds report 8 decimals (since Jun 23), and the fence's codes are what the calendar, the feed age and the
    /// ERC-8056 flags predict. The fence reference sits near the pool (both track the same market).
    function test_feedsAndFenceCodes() public {
        for (uint256 i; i < 2; ++i) {
            address feed = i == 0 ? Addresses4663.CL_USDG_USD : Addresses4663.CL_NVDA_USD;
            (, int256 answer,, uint256 updatedAt,) = AggregatorV3Interface(feed).latestRoundData();
            assertEq(AggregatorV3Interface(feed).decimals(), 8);
            assertGt(answer, 0);
            assertLe(updatedAt, block.timestamp);
        }
        assertEq(fence.status(address(USDG)), _expectedCode(address(USDG)), "USDG code");
        assertEq(fence.status(address(NVDA)), _expectedCode(address(NVDA)), "NVDA code");
        (uint256 p0,, uint8 c0) = fence.usdPrice(address(USDG));
        (uint256 p1,, uint8 c1) = fence.usdPrice(address(NVDA));
        emit log_named_uint("block", block.number);
        emit log_named_uint("timestamp", block.timestamp);
        emit log_named_uint("USDG code", c0);
        emit log_named_uint("NVDA code", c1);
        emit log_named_decimal_uint("USDG fence price", p0, 18);
        emit log_named_decimal_uint("NVDA fence price", p1, 18);
        if (p0 != 0 && p1 != 0) {
            (int24 ref, bool ok) = LaneMath.refTick(p0, p1, 6, 18);
            assertTrue(ok);
            int24 t = _tick();
            emit log_named_int("pool tick", t);
            emit log_named_int("fence reference tick", ref);
            assertLt(t > ref ? t - ref : ref - t, 500, "pool within 5% of the fence");
        }
        ChainlinkFence.TokenConfig memory n = fence.config(address(NVDA));
        assertEq(n.feed, Addresses4663.CL_NVDA_USD);
        assertEq(uint8(n.kind), uint8(ChainlinkFence.Kind.STOCK));
        assertEq(fence.tokens().length, 5);
    }

    function test_dealFundsBothTokens() public {
        address a = makeAddr("dealt");
        _fund(address(USDG), a, 1_234e6);
        _fund(address(NVDA), a, 5e18);
        assertEq(USDG.balanceOf(a), 1_234e6);
        assertEq(NVDA.balanceOf(a), 5e18);
    }

    /// @dev The raw-storage fallback: USDG balances at mapping slot 1, NVDA in OZ ERC-7201 ERC20Storage.
    function test_storeFallbackSlots() public {
        address a = makeAddr("stored");
        vm.store(address(USDG), keccak256(abi.encode(a, USDG_BALANCES_SLOT)), bytes32(uint256(777e6)));
        vm.store(address(NVDA), keccak256(abi.encode(a, OZ_ERC20_STORAGE)), bytes32(uint256(3e18)));
        assertEq(USDG.balanceOf(a), 777e6);
        assertEq(NVDA.balanceOf(a), 3e18);
        // and the pool's real balances read through the same slots
        assertEq(
            uint256(vm.load(address(USDG), _balanceSlot(address(USDG), address(POOL)))), USDG.balanceOf(address(POOL))
        );
        assertEq(
            uint256(vm.load(address(NVDA), _balanceSlot(address(NVDA), address(POOL)))), NVDA.balanceOf(address(POOL))
        );
    }

    function test_freshContractHoldsAndSendsNvda() public {
        Holder h = new Holder();
        _fund(address(NVDA), address(h), 2e18);
        _fund(address(USDG), address(h), 100e6);
        address to = makeAddr("recipient");
        h.send(NVDA, to, 1.5e18);
        h.send(USDG, to, 60e6);
        assertEq(NVDA.balanceOf(to), 1.5e18);
        assertEq(NVDA.balanceOf(address(h)), 0.5e18);
        assertEq(USDG.balanceOf(to), 60e6);
    }

    /// @dev script/Deploy.s.sol on the fork, then a lane at its predicted address, read back like CheckDeployment.
    function test_deployScriptAndLane() public {
        assertEq(factory.implementations(DeskDefaults.KIND_V3_LP), address(impl));
        assertTrue(factory.poolAllowed(Addresses4663.POOL_NVDA_USDG, DeskDefaults.KIND_V3_LP));
        assertEq(factory.V3_FACTORY(), Addresses4663.V3_FACTORY);
        assertEq(address(impl.NPM()), Addresses4663.NPM);
        assertEq(address(impl.FENCE()), address(fence));
        assertEq(keccak256(abi.encode(factory.ceilings())), keccak256(abi.encode(DeskDefaults.ceilings())));
        lane = _createLane(DeskDefaults.laneCaps());
        assertTrue(factory.isLane(address(lane)));
        assertEq(lane.owner(), owner);
        assertEq(lane.operator(), operator);
        assertEq(lane.guardian(), guardian);
        assertEq(lane.token0(), Addresses4663.USDG);
        assertEq(lane.token1(), Addresses4663.NVDA);
        (uint24 f, int24 sp, uint8 d0, uint8 d1) = lane.poolParams();
        assertEq(f, 500);
        assertEq(sp, 10);
        assertEq(d0, 6);
        assertEq(d1, 18);
        (, int24 band, uint8 code) = lane.refTick();
        assertEq(band, 100);
        assertEq(code, _expectedCode(address(USDG)) != 0 ? _expectedCode(address(USDG)) : _expectedCode(address(NVDA)));
    }

    /// @dev On the weekend block the stock fence is closed: risk-adding reverts MarketClosed(5), exits still work.
    function test_weekendBlockClosesRiskAdding() public {
        if (!LaneMath.stockWeekend(block.timestamp)) {
            vm.createSelectFork(rpc, vm.envOr("FORK_BLOCK_SATURDAY", SATURDAY_BLOCK));
            _deployDesk();
        }
        assertTrue(LaneMath.stockWeekend(block.timestamp));
        lane = _createLane(DeskDefaults.laneCaps());
        _fundUsd(address(lane), 25e6);
        uint8 want = _expectedCode(address(NVDA));
        assertEq(fence.status(address(NVDA)), want);
        (bool open, uint8 code) = lane.riskAddingOpen();
        assertFalse(open);
        IDeskTypes.RangeSpec[] memory r = new IDeskTypes.RangeSpec[](1);
        int24 t = _tick();
        r[0] = IDeskTypes.RangeSpec(LaneMath.floorTick(t - 100, 10), LaneMath.ceilTick(t + 100, 10), 10_000, 10_000);
        IDeskTypes.Meta memory m = _meta();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IDeskLane.MarketClosed.selector, code));
        lane.rerange(m, r, t, 10);
        emit log_named_uint("weekend NVDA code", want);
        _exitAll(operator);
        vm.prank(owner);
        lane.withdrawAll();
        assertEq(USDG.balanceOf(address(lane)) + NVDA.balanceOf(address(lane)), 0);
    }
}
