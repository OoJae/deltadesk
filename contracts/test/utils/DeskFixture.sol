// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {ChainlinkFence} from "../../src/ChainlinkFence.sol";
import {DeskLaneFactory} from "../../src/DeskLaneFactory.sol";
import {DeskLaneV3} from "../../src/DeskLaneV3.sol";
import {IDeskLane} from "../../src/interfaces/IDeskLane.sol";
import {IDeskLaneFactory} from "../../src/interfaces/IDeskLaneFactory.sol";
import {IDeskTypes} from "../../src/interfaces/IDeskTypes.sol";
import {INonfungiblePositionManagerMin as INPM} from "../../src/interfaces/external/INonfungiblePositionManagerMin.sol";
import {IUniswapV3FactoryMin} from "../../src/interfaces/external/IUniswapV3FactoryMin.sol";
import {PriceMath} from "../../src/libraries/PriceMath.sol";
import {DeskDefaults} from "../../script/DeskDefaults.sol";

import {IUniswapV3PoolTest} from "./IUniswapV3PoolTest.sol";
import {MockAggregator} from "./MockAggregator.sol";
import {MockStockToken, MockToken} from "./MockToken.sol";
import {PoolMover} from "./PoolMover.sol";
import {V3Deployer} from "./V3Deployer.sol";

/// @notice Local M2 desk: real Uniswap v3 factory + NPM (npm artifacts), mock USDG (6 dec, token0) and NVDA
/// (18 dec, ERC-8056, token1) in the live NVDA/USDG orientation, mock Chainlink feeds, ChainlinkFence, the lane
/// factory and implementation, a third-party LP for depth, and one funded lane with the default M2 caps.
abstract contract DeskFixture is Test {
    // Wed 2026-09-16 15:00:00 UTC: the stock fence is open.
    uint256 internal constant WEEKDAY_TS = 1_789_570_800;
    uint24 internal constant FEE = 500;
    int24 internal constant SPACING = 10;

    // Mock token addresses chosen so that USDG < NVDA, as on 4663 (token0 = USDG, token1 = NVDA).
    address internal constant USDG_ADDR = address(0x1000000000000000000000000000000000000A01);
    address internal constant NVDA_ADDR = address(0x2000000000000000000000000000000000000B02);

    int256 internal constant USDG_ANSWER = 1e8; // $1.00, 8 decimals
    int256 internal constant NVDA_ANSWER = 222.6e8; // $222.60, 8 decimals

    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");
    address internal lp = makeAddr("lp");

    MockToken internal usdg;
    MockStockToken internal nvda;
    MockAggregator internal usdgFeed;
    MockAggregator internal nvdaFeed;
    ChainlinkFence internal fence;

    IUniswapV3FactoryMin internal v3Factory;
    INPM internal npm;
    IUniswapV3PoolTest internal pool;
    PoolMover internal mover;

    DeskLaneFactory internal factory;
    DeskLaneV3 internal impl;
    DeskLaneV3 internal lane;

    uint256 private _decisionNonce;

    function setUp() public virtual {
        vm.warp(WEEKDAY_TS);

        deployCodeTo("MockToken.sol:MockToken", abi.encode("Global Dollar", "USDG", uint8(6)), USDG_ADDR);
        deployCodeTo("MockToken.sol:MockStockToken", abi.encode("NVIDIA", "NVDA", uint8(18)), NVDA_ADDR);
        usdg = MockToken(USDG_ADDR);
        nvda = MockStockToken(NVDA_ADDR);
        vm.label(USDG_ADDR, "USDG");
        vm.label(NVDA_ADDR, "NVDA");

        usdgFeed = new MockAggregator(8, USDG_ANSWER);
        nvdaFeed = new MockAggregator(8, NVDA_ANSWER);
        fence = new ChainlinkFence(_fenceConfigs());

        (address f, address n) = V3Deployer.deploy(makeAddr("weth9"), makeAddr("descriptor"));
        v3Factory = IUniswapV3FactoryMin(f);
        npm = INPM(n);
        pool = IUniswapV3PoolTest(v3Factory.createPool(USDG_ADDR, NVDA_ADDR, FEE));
        (uint256 sqrtP, bool ok) = PriceMath.sqrtPriceX96(1e18, 222.6e18, 6, 18);
        require(ok, "fixture price");
        pool.initialize(uint160(sqrtP));
        mover = new PoolMover(address(pool));
        _seedPoolLiquidity();

        factory = new DeskLaneFactory(admin, address(v3Factory), DeskDefaults.ceilings());
        impl = new DeskLaneV3(address(factory), address(npm), address(fence));
        vm.startPrank(admin);
        factory.setImplementation(DeskDefaults.KIND_V3_LP, address(impl));
        factory.setPoolAllowed(address(pool), DeskDefaults.KIND_V3_LP, true);
        vm.stopPrank();

        lane = DeskLaneV3(_createLane(owner, operator, guardian, bytes32(0)));
        _fundLane(25e6, 0.11e18); // about $49.5
    }

    // ------------------------------------------------------------------ setup helpers

    function _fenceConfigs() internal view virtual returns (ChainlinkFence.TokenConfig[] memory c) {
        c = new ChainlinkFence.TokenConfig[](2);
        c[0] = ChainlinkFence.TokenConfig(USDG_ADDR, address(usdgFeed), ChainlinkFence.Kind.STABLE, 26 hours);
        c[1] = ChainlinkFence.TokenConfig(NVDA_ADDR, address(nvdaFeed), ChainlinkFence.Kind.STOCK, 26 hours);
    }

    /// @dev A wide third-party position (about +-45% around the price) so swaps have depth and generate fees.
    function _seedPoolLiquidity() internal {
        (, int24 tick,,,,,) = pool.slot0();
        int24 tl = _floor(tick - 6000);
        int24 tu = _floor(tick + 6000);
        usdg.mint(lp, 2_000_000e6);
        nvda.mint(lp, 9_000e18);
        vm.startPrank(lp);
        usdg.approve(address(npm), type(uint256).max);
        nvda.approve(address(npm), type(uint256).max);
        npm.mint(INPM.MintParams(USDG_ADDR, NVDA_ADDR, FEE, tl, tu, 1_000_000e6, 4_500e18, 0, 0, lp, block.timestamp));
        vm.stopPrank();
    }

    function _params(address owner_, address operator_, address guardian_, bytes32 salt)
        internal
        view
        returns (IDeskLaneFactory.CreateParams memory)
    {
        return IDeskLaneFactory.CreateParams({
            owner: owner_,
            operator: operator_,
            guardian: guardian_,
            laneId: DeskDefaults.LANE_A,
            kind: DeskDefaults.KIND_V3_LP,
            pool: address(pool),
            caps: DeskDefaults.laneCaps(),
            salt: salt
        });
    }

    function _createLane(address owner_, address operator_, address guardian_, bytes32 salt)
        internal
        returns (address)
    {
        vm.prank(owner_);
        return factory.createLane(_params(owner_, operator_, guardian_, salt));
    }

    function _fundLane(uint256 usdgAmount, uint256 nvdaAmount) internal {
        usdg.mint(address(lane), usdgAmount);
        nvda.mint(address(lane), nvdaAmount);
    }

    // ------------------------------------------------------------------ action helpers

    function _meta() internal returns (IDeskTypes.Meta memory) {
        return _metaWithDeadline(uint64(block.timestamp + 60));
    }

    function _metaWithDeadline(uint64 deadline) internal returns (IDeskTypes.Meta memory) {
        return IDeskTypes.Meta({
            decisionId: keccak256(abi.encode("decision", ++_decisionNonce)),
            deadline: deadline,
            regime: 1,
            gatesMask: 0,
            reasonHash: keccak256("reason")
        });
    }

    function _tick() internal view returns (int24 tick) {
        (, tick,,,,,) = pool.slot0();
    }

    function _floor(int24 t) internal pure returns (int24) {
        int24 r = t % SPACING;
        return r < 0 ? t - r - SPACING : t - r;
    }

    function _ceil(int24 t) internal pure returns (int24) {
        int24 f = _floor(t);
        return f == t ? t : f + SPACING;
    }

    /// @dev One full-balance straddle [floor(tick - half), ceil(tick + half)].
    function _straddle(int24 half) internal view returns (IDeskTypes.RangeSpec[] memory r) {
        int24 tick = _tick();
        r = new IDeskTypes.RangeSpec[](1);
        r[0] = IDeskTypes.RangeSpec(_floor(tick - half), _ceil(tick + half), 10_000, 10_000);
    }

    function _rerangeAs(address who, IDeskTypes.RangeSpec[] memory ranges)
        internal
        returns (uint256[] memory tokenIds, uint128[] memory liquidities, uint256 used0, uint256 used1)
    {
        IDeskTypes.Meta memory m = _meta();
        int24 expected = _tick();
        vm.prank(who);
        return lane.rerange(m, ranges, expected, 10);
    }

    function _rerange(IDeskTypes.RangeSpec[] memory ranges)
        internal
        returns (uint256[] memory tokenIds, uint128[] memory liquidities, uint256 used0, uint256 used1)
    {
        return _rerangeAs(operator, ranges);
    }

    function _positionLiquidity(uint256 tokenId) internal view returns (uint128 liquidity) {
        (,,,,,,, liquidity,,,,) = npm.positions(tokenId);
    }

    /// @dev Move time forward keeping the mock feeds fresh (as a live feed would be during the session).
    function _warpFresh(uint256 dt) internal {
        vm.warp(block.timestamp + dt);
        usdgFeed.setUpdatedAt(block.timestamp);
        nvdaFeed.setUpdatedAt(block.timestamp);
    }

    function _sqrtAt(int24 tick) internal pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(tick);
    }
}
