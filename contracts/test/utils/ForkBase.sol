// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ChainlinkFence} from "../../src/ChainlinkFence.sol";
import {DeskLaneFactory} from "../../src/DeskLaneFactory.sol";
import {DeskLaneV3} from "../../src/DeskLaneV3.sol";
import {IDeskLaneFactory} from "../../src/interfaces/IDeskLaneFactory.sol";
import {IDeskTypes} from "../../src/interfaces/IDeskTypes.sol";
import {AggregatorV3Interface} from "../../src/interfaces/external/AggregatorV3Interface.sol";
import {IERC8056} from "../../src/interfaces/external/IERC8056.sol";
import {INonfungiblePositionManagerMin as INPM} from "../../src/interfaces/external/INonfungiblePositionManagerMin.sol";
import {Addresses4663} from "../../script/Addresses4663.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {DeskDefaults} from "../../script/DeskDefaults.sol";
import {IUniswapV3PoolTest} from "./IUniswapV3PoolTest.sol";
import {LaneMath} from "./LaneMath.sol";
import {PoolMover} from "./PoolMover.sol";

/// @notice Robinhood Chain (4663) fork setup shared by test/fork (FOUNDRY_PROFILE=fork).
/// Env:
///   RH_ARCHIVE_RPC  an archive RPC for 4663 (Alchemy). Unset: every fork test is skipped (vm.skip).
///   FORK_BLOCK      a block number, or "latest". Default: WEEKDAY_BLOCK (the public RPC keeps only ~30 min of state,
///                   so a pinned block needs an archive node; "latest" works with the public RPC).
///   FORK_BLOCK_SATURDAY  the weekend block for the weekend tests. Default: SATURDAY_BLOCK.
/// The desk is deployed with script/Deploy.s.sol itself (the agent's e2e does the same on anvil), unless
/// DEPLOYMENTS_FILE is set, in which case it is deployed directly so a test can never write a deployment record.
abstract contract ForkBase is Test {
    /// @dev Fri 2026-09-18 15:00:00 UTC (11:00 ET, regular session). Found by bisection over block timestamps.
    uint256 internal constant WEEKDAY_BLOCK = 66_315_359;
    /// @dev Sat 2026-09-19 06:00:00 UTC (the stock fence is in its weekend window).
    uint256 internal constant SATURDAY_BLOCK = 66_851_211;
    /// @dev USDG keeps balances in a plain mapping at slot 1 (checked against balanceOf on 2026-09-19).
    uint256 internal constant USDG_BALANCES_SLOT = 1;
    /// @dev NVDA is OpenZeppelin ERC20Upgradeable v5: balances are the first field of ERC-7201 "openzeppelin.storage.ERC20".
    bytes32 internal constant OZ_ERC20_STORAGE = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00;

    IERC20 internal constant USDG = IERC20(Addresses4663.USDG);
    IERC20 internal constant NVDA = IERC20(Addresses4663.NVDA);
    INPM internal constant NPM = INPM(Addresses4663.NPM);
    IUniswapV3PoolTest internal constant POOL = IUniswapV3PoolTest(Addresses4663.POOL_NVDA_USDG);

    address internal owner = makeAddr("vault");
    address internal operator = makeAddr("operator");
    address internal guardian = makeAddr("guardian");
    address internal attacker = makeAddr("attacker");

    string internal rpc;
    ChainlinkFence internal fence;
    DeskLaneFactory internal factory;
    DeskLaneV3 internal impl;
    address internal admin;
    DeskLaneV3 internal lane;
    PoolMover internal mover;
    bool internal feedsMocked;
    mapping(address feed => int256) internal _mocked;
    uint256 internal _nonce;

    // ------------------------------------------------------------------ fork

    /// @notice Fork 4663 at FORK_BLOCK (default `defaultBlock`); false (and the test skipped) without RH_ARCHIVE_RPC.
    function _fork(uint256 defaultBlock) internal returns (bool) {
        rpc = vm.envOr("RH_ARCHIVE_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return false;
        }
        string memory b = vm.envOr("FORK_BLOCK", string(""));
        if (keccak256(bytes(b)) == keccak256("latest")) vm.createSelectFork(rpc);
        else if (bytes(b).length != 0) vm.createSelectFork(rpc, vm.parseUint(b));
        else vm.createSelectFork(rpc, defaultBlock);
        return true;
    }

    function _forkingLatest() internal view returns (bool) {
        return keccak256(bytes(vm.envOr("FORK_BLOCK", string("")))) == keccak256("latest");
    }

    // ------------------------------------------------------------------ desk

    function _deployDesk() internal {
        if (bytes(vm.envOr("DEPLOYMENTS_FILE", string(""))).length == 0) {
            Deploy.Deployment memory d = new Deploy().run();
            fence = ChainlinkFence(d.fence);
            factory = DeskLaneFactory(d.factory);
            impl = DeskLaneV3(d.implementation);
            admin = d.admin;
        } else {
            admin = makeAddr("admin");
            fence = new ChainlinkFence(DeskDefaults.fenceConfigs4663());
            factory = new DeskLaneFactory(admin, Addresses4663.V3_FACTORY, DeskDefaults.ceilings());
            impl = new DeskLaneV3(address(factory), Addresses4663.NPM, address(fence));
            vm.startPrank(admin);
            factory.setImplementation(DeskDefaults.KIND_V3_LP, address(impl));
            factory.setPoolAllowed(Addresses4663.POOL_NVDA_USDG, DeskDefaults.KIND_V3_LP, true);
            vm.stopPrank();
        }
        vm.label(address(fence), "ChainlinkFence");
        vm.label(address(factory), "DeskLaneFactory");
        vm.label(address(impl), "DeskLaneV3");
        vm.label(address(USDG), "USDG");
        vm.label(address(NVDA), "NVDA");
        vm.label(address(POOL), "NVDA/USDG");
        vm.label(address(NPM), "NPM");
    }

    function _params(IDeskTypes.Caps memory caps, bytes32 salt)
        internal
        view
        returns (IDeskLaneFactory.CreateParams memory)
    {
        return IDeskLaneFactory.CreateParams({
            owner: owner,
            operator: operator,
            guardian: guardian,
            laneId: DeskDefaults.LANE_A,
            kind: DeskDefaults.KIND_V3_LP,
            pool: Addresses4663.POOL_NVDA_USDG,
            caps: caps,
            salt: salt
        });
    }

    function _createLane(IDeskTypes.Caps memory caps) internal returns (DeskLaneV3 l) {
        IDeskLaneFactory.CreateParams memory p = _params(caps, bytes32(0));
        address predicted = factory.predictLane(p);
        vm.prank(owner);
        l = DeskLaneV3(factory.createLane(p));
        assertEq(address(l), predicted, "lane != predictLane");
        vm.label(address(l), "lane");
    }

    /// @notice Fund `to` with ~`usd6Each` of USDG and of NVDA at the fence price.
    function _fundUsd(address to, uint256 usd6Each) internal {
        (uint256 p1,,) = fence.usdPrice(address(NVDA));
        require(p1 != 0, "no NVDA fence price");
        _fund(address(USDG), to, USDG.balanceOf(to) + usd6Each);
        _fund(address(NVDA), to, NVDA.balanceOf(to) + usd6Each * 1e30 / p1);
    }

    /// @notice Set `to`'s balance of `token` to exactly `amount`: forge-std deal, falling back to the known slots.
    function _fund(address token, address to, uint256 amount) internal {
        try this.forkDeal(token, to, amount) {} catch {}
        if (IERC20(token).balanceOf(to) != amount) vm.store(token, _balanceSlot(token, to), bytes32(amount));
        assertEq(IERC20(token).balanceOf(to), amount, "fund");
    }

    function forkDeal(address token, address to, uint256 amount) external {
        deal(token, to, amount);
    }

    function _balanceSlot(address token, address who) internal pure returns (bytes32) {
        if (token == address(USDG)) return keccak256(abi.encode(who, USDG_BALANCES_SLOT));
        return keccak256(abi.encode(who, OZ_ERC20_STORAGE));
    }

    /// @notice A PoolMover on the real pool, stocked far beyond what moving the pool a few hundred ticks costs.
    function _mover() internal returns (PoolMover m) {
        m = new PoolMover(address(POOL));
        _fund(address(USDG), address(m), 50_000_000e6);
        _fund(address(NVDA), address(m), 200_000e18);
        vm.label(address(m), "mover");
    }

    // ------------------------------------------------------------------ market state

    /// @notice Make risk-adding possible: on a weekend block, warp to Monday 02:00 UTC; if a feed then reads stale,
    /// answer it with its live round re-stamped now (vm.mockCall). Returns whether feeds were mocked.
    function _openMarket() internal returns (bool) {
        if (LaneMath.stockWeekend(block.timestamp)) {
            uint256 day = block.timestamp / 1 days;
            uint256 toMonday = (7 - LaneMath.weekdayMon0(block.timestamp)) % 7;
            uint256 target = (day + toMonday) * 1 days + 2 hours;
            vm.roll(block.number + (target - block.timestamp) * 10);
            vm.warp(target);
        }
        if (fence.status(address(USDG)) == 2 || fence.status(address(NVDA)) == 2) _mockFreshFeeds();
        return feedsMocked;
    }

    /// @notice Answer both feeds with their live answers stamped at the current time.
    function _mockFreshFeeds() internal {
        _setFeed(Addresses4663.CL_USDG_USD, _answer(Addresses4663.CL_USDG_USD));
        _setFeed(Addresses4663.CL_NVDA_USD, _answer(Addresses4663.CL_NVDA_USD));
    }

    /// @notice Re-stamp the mocked feeds at the current time (after a warp).
    function _restampFeeds() internal {
        if (!feedsMocked) return;
        _setFeed(Addresses4663.CL_USDG_USD, _answer(Addresses4663.CL_USDG_USD));
        _setFeed(Addresses4663.CL_NVDA_USD, _answer(Addresses4663.CL_NVDA_USD));
    }

    /// @notice Warp forward keeping the fence usable the way a live session would: re-stamp mocked feeds, and mock a
    /// feed that crossed its max age.
    function _warpFresh(uint256 dt) internal {
        vm.warp(block.timestamp + dt);
        vm.roll(block.number + dt * 10);
        if (feedsMocked) _restampFeeds();
        else if (fence.status(address(USDG)) == 2 || fence.status(address(NVDA)) == 2) _mockFreshFeeds();
    }

    /// @notice Answer `feed` with `answer` (feed decimals), stamped now.
    function _setFeed(address feed, int256 answer) internal {
        _mocked[feed] = answer;
        feedsMocked = true;
        vm.mockCall(
            feed,
            abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector),
            abi.encode(uint80(1), answer, block.timestamp, block.timestamp, uint80(1))
        );
    }

    /// @notice The feed's current answer: the mocked one if any, else its live round.
    function _answer(address feed) internal view returns (int256 answer) {
        answer = _mocked[feed];
        if (answer == 0) (, answer,,,) = AggregatorV3Interface(feed).latestRoundData();
    }

    /// @notice The fence code of `token` as its definition predicts from the chain's own state (calendar, feed age,
    /// ERC-8056 flags, peg).
    function _expectedCode(address token) internal view returns (uint8) {
        address feed = token == address(USDG) ? Addresses4663.CL_USDG_USD : Addresses4663.CL_NVDA_USD;
        (, int256 answer,, uint256 updatedAt,) = AggregatorV3Interface(feed).latestRoundData();
        if (answer <= 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > DeskDefaults.FEED_MAX_AGE) {
            return 2;
        }
        uint256 px = uint256(answer) * 1e18 / 10 ** AggregatorV3Interface(feed).decimals();
        if (token == address(USDG)) return (px > 1e18 ? px - 1e18 : 1e18 - px) > 5e15 ? 6 : 0;
        if (IERC8056(token).oraclePaused()) return 3;
        uint256 at = IERC8056(token).effectiveAt();
        if (at != 0 && (block.timestamp > at ? block.timestamp - at : at - block.timestamp) < 2 hours) return 4;
        return LaneMath.stockWeekend(block.timestamp) ? 5 : 0;
    }

    // ------------------------------------------------------------------ lane actions

    function _meta() internal returns (IDeskTypes.Meta memory) {
        return IDeskTypes.Meta({
            decisionId: keccak256(abi.encode("fork", ++_nonce)),
            deadline: uint64(block.timestamp + 60),
            regime: 1,
            gatesMask: 0,
            reasonHash: keccak256(abi.encode(_nonce))
        });
    }

    function _tick() internal view returns (int24 t) {
        (, t,,,,,) = POOL.slot0();
    }

    function _refTick() internal view returns (int24 ref, int24 band) {
        uint8 code;
        (ref, band, code) = lane.refTick();
        require(code == 0 || code == 5, "fence price unusable");
    }

    /// @notice Ranges the placement fence accepts at the current pool tick: a straddle within the band, else the
    /// single-sided ranges on the allowed sides.
    function _fenceSafeRanges(int24 half, uint16 share) internal view returns (IDeskTypes.RangeSpec[] memory r) {
        int24 t = _tick();
        (int24 ref, int24 band) = _refTick();
        if (t >= ref - band && t <= ref + band) {
            r = new IDeskTypes.RangeSpec[](1);
            r[0] = IDeskTypes.RangeSpec(LaneMath.floorTick(t - half, 10), LaneMath.ceilTick(t + half, 10), share, share);
            return r;
        }
        r = new IDeskTypes.RangeSpec[](2);
        if (t > ref + band) {
            int24 tl = LaneMath.ceilTick(t + 1, 10);
            int24 tu = LaneMath.floorTick(ref + band, 10);
            r[0] = IDeskTypes.RangeSpec(tl, tl + 2 * half, share, 0);
            r[1] = IDeskTypes.RangeSpec(tu - 2 * half, tu, 0, share);
        } else {
            int24 tu = LaneMath.floorTick(t, 10);
            int24 tl = LaneMath.ceilTick(ref - band, 10);
            r[0] = IDeskTypes.RangeSpec(tl, tl + 2 * half, share, 0);
            r[1] = IDeskTypes.RangeSpec(tu - 2 * half, tu, 0, share);
        }
    }

    function _rerange(IDeskTypes.RangeSpec[] memory r)
        internal
        returns (uint256[] memory ids, uint128[] memory liq, uint256 used0, uint256 used1)
    {
        IDeskTypes.Meta memory m = _meta();
        int24 t = _tick();
        vm.prank(operator);
        return lane.rerange(m, r, t, 10);
    }

    function _assertNoAllowances() internal view {
        assertEq(USDG.allowance(address(lane), address(NPM)), 0, "USDG allowance");
        assertEq(NVDA.allowance(address(lane), address(NPM)), 0, "NVDA allowance");
    }

    /// @notice The lane's fence-valued NAV (usd6): idle balances plus tracked positions at the pool price.
    function _navUsd6() internal view returns (uint256 v) {
        (uint256 p0,,) = fence.usdPrice(address(USDG));
        (uint256 p1,,) = fence.usdPrice(address(NVDA));
        (uint160 s,,,,,,) = POOL.slot0();
        v = LaneMath.usd6(USDG.balanceOf(address(lane)), p0, 6) + LaneMath.usd6(NVDA.balanceOf(address(lane)), p1, 18);
        uint256[2] memory t = lane.positions();
        for (uint256 i; i < 2; ++i) {
            if (t[i] == 0) continue;
            (,,,,, int24 tl, int24 tu, uint128 liq,,, uint128 o0, uint128 o1) = NPM.positions(t[i]);
            (uint256 a0, uint256 a1) = LaneMath.amounts(s, tl, tu, liq);
            v += LaneMath.usd6(a0 + o0, p0, 6) + LaneMath.usd6(a1 + o1, p1, 18);
        }
    }

    function _positionLiquidity(uint256 id) internal view returns (uint128 liq) {
        (,,,,,,, liq,,,,) = NPM.positions(id);
    }

    function _positionOwed(uint256 id) internal view returns (uint128 o0, uint128 o1) {
        (,,,,,,,,,, o0, o1) = NPM.positions(id);
    }

    function _exitAll(address who) internal {
        IDeskTypes.Meta memory m = _meta();
        vm.prank(who);
        lane.exitAll(m);
    }

    /// @notice Every value exit of the lane goes to the owner: an unrelated guard used after each stage.
    function _assertLaneAddressesUnchanged() internal view {
        assertEq(lane.owner(), owner);
        assertEq(lane.operator(), operator);
        assertEq(lane.pool(), Addresses4663.POOL_NVDA_USDG);
        assertEq(lane.fence(), address(fence));
    }
}
