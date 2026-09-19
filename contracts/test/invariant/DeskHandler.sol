// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {DeskLaneV3} from "../../src/DeskLaneV3.sol";
import {IDeskLane} from "../../src/interfaces/IDeskLane.sol";
import {IDeskTypes} from "../../src/interfaces/IDeskTypes.sol";
import {IPriceFence} from "../../src/interfaces/IPriceFence.sol";
import {INonfungiblePositionManagerMin as INPM} from "../../src/interfaces/external/INonfungiblePositionManagerMin.sol";
import {IUniswapV3PoolTest} from "../utils/IUniswapV3PoolTest.sol";
import {LaneMath} from "../utils/LaneMath.sol";
import {PoolMover} from "../utils/PoolMover.sol";
import {DeskEnv} from "./DeskEnv.sol";

/// @dev NPM entry points the attacker uses beyond what the lane needs.
interface INPMAttack {
    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1);

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external;
}

/// @title Invariant handler for one DeskLane (docs/m2-design-contracts.md, "Invariant suite").
/// @notice Actors: the owner, an honest operator, an evil operator (the same operator key, compromised: random calldata
/// over every selector and crafted off-market ranges), an attacker (swaps around every operator action, calls
/// everything, donates, sends NFTs, calls the NPM directly), the guardian; plus the environment (forward-only warps
/// across the UTC weekend window, pool moves, Chainlink price/age/decimals/revert, oraclePaused, effectiveAt, token
/// pauses).
/// Every lane call and every attacker segment runs under vm.recordLogs and a LOG AUDITOR classifies each ERC-20
/// Transfer from the lane and each ERC-721 Transfer of a lane-owned NFT. Independent models (config, decisionIds,
/// token buckets, fence codes and reference tick, fence-valued NAV) are kept alongside. Anything the handler observes
/// mid-call is recorded as a violation of invariant In (it never reverts on a finding: fail_on_revert is off), and
/// DeskInvariantBase asserts that every counter stays 0 and that the view checks below hold after every call.
contract DeskHandler is Test {
    // ------------------------------------------------------------------ event topics
    bytes32 internal constant TRANSFER = keccak256("Transfer(address,address,uint256)");
    bytes32 internal constant APPROVAL = keccak256("Approval(address,address,uint256)");
    bytes32 internal constant APPROVAL_FOR_ALL = keccak256("ApprovalForAll(address,address,bool)");
    bytes32 internal constant NPM_INCREASE = keccak256("IncreaseLiquidity(uint256,uint128,uint256,uint256)");
    bytes32 internal constant NPM_DECREASE = keccak256("DecreaseLiquidity(uint256,uint128,uint256,uint256)");
    bytes32 internal constant NPM_COLLECT = keccak256("Collect(uint256,address,uint256,uint256)");
    bytes32 internal constant POOL_MINT = keccak256("Mint(address,address,int24,int24,uint128,uint256,uint256)");

    uint256 internal constant WAD = 1e18;
    uint256 internal constant EXIT_GAS = 3_000_000;
    uint256 internal constant N_SELECTORS = 45;

    // ------------------------------------------------------------------ inner actions (stats)
    uint8 internal constant A_HONEST_RERANGE = 0;
    uint8 internal constant A_HONEST_REDUCING = 1;
    uint8 internal constant A_EVIL_RERANGE = 2;
    uint8 internal constant A_EVIL_CALL = 3;
    uint8 internal constant A_EVIL_RAW = 4;
    uint8 internal constant A_ATK_SWAP = 5;
    uint8 internal constant A_ATK_DONATE = 6;
    uint8 internal constant A_ATK_NFT = 7;
    uint8 internal constant A_ATK_NPM = 8;
    uint8 internal constant A_ATK_INCREASE = 9;
    uint8 internal constant A_ATK_CALLBACK = 10;
    uint8 internal constant A_ATK_LANE = 11;
    uint8 internal constant A_OWN_WITHDRAW = 12;
    uint8 internal constant A_OWN_WITHDRAW_ALL = 13;
    uint8 internal constant A_OWN_WITHDRAW_POS = 14;
    uint8 internal constant A_OWN_PAUSE = 15;
    uint8 internal constant A_OWN_UNPAUSE = 16;
    uint8 internal constant A_OWN_TIGHTEN = 17;
    uint8 internal constant A_OWN_LOOSEN = 18;
    uint8 internal constant A_OWN_APPLY_CAPS = 19;
    uint8 internal constant A_OWN_CANCEL_CAPS = 20;
    uint8 internal constant A_OWN_OPERATOR = 21;
    uint8 internal constant A_OWN_GUARDIAN = 22;
    uint8 internal constant A_OWN_CLOSED_UNTIL = 23;
    uint8 internal constant A_OWN_DEPOSIT = 24;
    uint8 internal constant A_OWN_RERANGE = 25;
    uint8 internal constant A_GUARD_REDUCING = 26;
    uint8 internal constant A_GUARD_CLOSED_UNTIL = 27;
    uint8 internal constant A_GUARD_FORBIDDEN = 28;
    uint8 internal constant A_WARP = 29;
    uint8 internal constant A_MOVE = 30;
    uint8 internal constant A_CL_STOCK_STEP = 31;
    uint8 internal constant A_CL_QUOTE_STEP = 32;
    uint8 internal constant A_CL_AGE = 33;
    uint8 internal constant A_CL_DECIMALS = 34;
    uint8 internal constant A_CL_REVERT = 35;
    uint8 internal constant A_CL_BROKEN = 36;
    uint8 internal constant A_ORACLE_PAUSED = 37;
    uint8 internal constant A_CORP_ACTION = 38;
    uint8 internal constant A_CL_HEAL = 39;
    uint8 internal constant A_TOKEN_PAUSE = 40;
    uint8 internal constant N_ACTIONS = 41;

    // ------------------------------------------------------------------ wiring
    struct Wiring {
        DeskLaneV3 lane;
        INPM npm;
        IUniswapV3PoolTest pool;
        PoolMover mover;
        DeskEnv env;
        address owner;
        address operator;
        address operator2;
        address guardian;
        address guardian2;
        address attacker;
        address junk; // an unrelated ERC-20 with open minting (donations, owner withdraw of foreign tokens)
        address decoyPool; // same tokens, another fee tier (foreign positions sent to the lane)
        bool fork;
    }

    DeskLaneV3 public immutable lane;
    INPM public immutable npm;
    IUniswapV3PoolTest public immutable pool;
    PoolMover public immutable mover;
    DeskEnv public immutable env;
    address public immutable owner;
    address public immutable operator1;
    address public immutable operator2;
    address public immutable guardian1;
    address public immutable guardian2;
    address public immutable attacker;
    address public immutable junk;
    address public immutable decoyPool;
    bool public immutable fork;
    address public immutable token0;
    address public immutable token1;
    uint8 public immutable dec0;
    uint8 public immutable dec1;
    int24 public immutable spacing;
    uint24 public immutable fee;
    uint8 public immutable stock; // env.stockIndex()
    uint256 public immutable stockPrice8AtStart;

    bytes4[] internal _sels;
    IDeskTypes.Caps internal _ceil;

    // ------------------------------------------------------------------ ghost: config model (I8)
    address public mOperator;
    address public mPendingOp;
    uint64 public mPendingOpEta;
    address public mGuardian;
    IDeskTypes.Caps internal mCaps;
    IDeskTypes.Caps internal mPendingCaps;
    uint64 public mPendingCapsEta;
    bool public mPaused;
    uint64 public mClosedUntil;

    // ------------------------------------------------------------------ ghost: decisionIds (I3)
    bytes32[] internal _ids;
    mapping(bytes32 => bool) internal _known;
    mapping(bytes32 => uint64) public expectUsedAt;
    uint256 internal _nonce;

    // ------------------------------------------------------------------ ghost: buckets and interval (I4)
    /// @dev Exact level x period (no rounding at all), refilled lazily with the CURRENT cap, like the lane.
    struct MBucket {
        uint256 num;
        uint256 last;
    }

    MBucket internal mTurn;
    MBucket internal mRr1h;
    MBucket internal mRr24h;
    uint64 public mLastRerange;
    uint256 public bucketWrites; // bounds the lane's WAD rounding (< 1 wei-WAD per write)

    // ------------------------------------------------------------------ ghost: fence-valued NAV (I7)
    int256 public pnlClosed; // sum of (NAV_end + out - NAV_start - in) over closed constant-price epochs
    uint256 public epochStartNav;
    uint256 public epochIn;
    uint256 public epochOut;
    uint256 public lossBudget; // band x notional per mint + exposure created by price steps and liquidity donations
    uint256 public slack; // rounding allowance, a few usd6 per mint/burn/valuation
    uint256 public turnoverUsed; // usd6 minted (fence-valued, rounded up)

    // ------------------------------------------------------------------ ghost: NFTs (I12)
    uint256[] internal _foreign;
    mapping(uint256 => bool) internal _isForeign;

    // ------------------------------------------------------------------ corporate action (I14)
    bool public corpPending;
    uint256 public corpAt;
    uint256 public corpRatioE18;

    // ------------------------------------------------------------------ findings and stats
    uint256[15] public violations;
    string[15] internal _first;

    uint8 internal _act;
    uint256[41] public actCalls;
    uint256[41] public actLaneOk;
    uint256[41] public actLaneReverts;
    mapping(bytes4 => uint256) public revertsBy;
    bytes4[] internal _revertSels;
    uint256 public riskReranges;
    uint256 public mints;
    uint256 public priceSteps;
    uint256 public corpSteps;
    uint256 public donations;
    uint256 public maxExitGas;
    uint256 public maxMintDevBps; // max over mints of worst-case loss / (band x notional), bps
    uint256 public maxLossOfBudgetBps; // max over the run of fence-valued loss / I7 allowance, bps
    int24[] internal _lastTicks;
    bool internal _started;
    uint256 internal _seq;

    constructor(Wiring memory w) {
        lane = w.lane;
        npm = w.npm;
        pool = w.pool;
        mover = w.mover;
        env = w.env;
        owner = w.owner;
        operator1 = w.operator;
        operator2 = w.operator2;
        guardian1 = w.guardian;
        guardian2 = w.guardian2;
        attacker = w.attacker;
        junk = w.junk;
        decoyPool = w.decoyPool;
        fork = w.fork;
        token0 = w.lane.token0();
        token1 = w.lane.token1();
        (uint24 fee_, int24 spacing_, uint8 d0, uint8 d1) = w.lane.poolParams();
        fee = fee_;
        spacing = spacing_;
        dec0 = d0;
        dec1 = d1;
        stock = w.env.stockIndex();
        stockPrice8AtStart = w.env.feed(w.env.stockIndex()).price8;

        _ceil = w.lane.CEILINGS();
        mOperator = w.lane.operator();
        mGuardian = w.lane.guardian();
        mCaps = w.lane.caps();
        mPaused = w.lane.paused();
        mClosedUntil = w.lane.closedUntil();
        (mPendingOp, mPendingOpEta) = w.lane.pendingOperator();
        (IDeskTypes.Caps memory pc, uint64 pcEta) = w.lane.pendingCaps();
        mPendingCaps = pc;
        mPendingCapsEta = pcEta;
        mLastRerange = w.lane.lastRerangeAt();
        // The lane starts with full buckets (checked by checkI4 before the first call).
        mTurn = MBucket(uint256(mCaps.turnoverUsd6PerDay) * 1 days, block.timestamp);
        mRr1h = MBucket(uint256(mCaps.reranges1h) * 1 hours, block.timestamp);
        mRr24h = MBucket(uint256(mCaps.reranges24h) * 1 days, block.timestamp);

        _initSelectors();

        vm.startPrank(w.attacker);
        IERC20(w.lane.token0()).approve(address(w.npm), type(uint256).max);
        IERC20(w.lane.token1()).approve(address(w.npm), type(uint256).max);
        vm.stopPrank();
    }

    /// @notice Opens the first valuation epoch; the test calls it once, right after deploying the handler.
    function start() external {
        if (_started) return;
        _started = true;
        epochStartNav = nav();
    }

    // ================================================================== honest operator

    /// @notice The honest agent (or the owner acting for it): a fence-respecting rerange, sized under the deploy cap
    /// and the turnover left, or a risk-reducing step while risk-adding is closed. The attacker may front-run it and
    /// trades right after it.
    function honestRerange(uint256 seed) external {
        seed = _mix(seed);
        bool asOwner = seed % 6 == 0 || mOperator == address(0);
        _begin(asOwner ? A_OWN_RERANGE : A_HONEST_RERANGE);
        address who = asOwner ? owner : mOperator;
        if (!_openNow()) {
            if (seed % 4 != 0) {
                _reducing(who, seed >> 8);
                return;
            }
        } else {
            _waitForBudgets(seed >> 200);
        }
        _honestRerange(who, seed >> 8);
    }

    /// @notice The honest agent's risk-reducing steps: collect, reduce, exitAll, unwind-and-hold, signal, pause.
    function honestReduce(uint256 seed) external {
        seed = _mix(seed);
        _begin(A_HONEST_REDUCING);
        _reducing(mOperator == address(0) ? owner : mOperator, seed);
    }

    // ================================================================== evil operator (the operator key, compromised)

    /// @notice Crafted off-market placements at and beyond the fence edges, bad shapes, too many ranges, bad metas and
    /// tick guards, sandwiched by the attacker (pool parked at the edge first, arbitraged to the fence price after).
    /// One mode parks the pool thousands of ticks beyond the band on a tick edge and places a range whose in-range
    /// edge is the pool tick itself (tl == tc, or tu == tc + 1), where only the current bucket holds the risky side.
    function evilRerange(uint256 seed) external {
        seed = _mix(seed);
        _begin(A_EVIL_RERANGE);
        address who = mOperator == address(0) ? operator1 : mOperator;
        IDeskTypes.Caps memory c = mCaps;
        int24 ref = _refOrFair();
        int24 band = int24(uint24(c.placeBandBps));
        uint256 k = seed % 5;
        if (k == 0) _moveTo(ref + band - int24(_randInt(seed >> 8, 0, 3)));
        else if (k == 1) _moveTo(ref - band + int24(_randInt(seed >> 8, 0, 3)));
        else if (k == 2) _moveTo(ref + int24(_randInt(seed >> 8, -int256(band) - 20, int256(band) + 20)));
        else if (k == 3) _parkFar(ref, band, seed >> 8);
        if (_openNow() && seed % 4 != 0) _waitForBudgets(seed >> 200);
        int24 t0 = _tick();
        IDeskTypes.RangeSpec[] memory r =
            k == 3 ? _atPoolTick(t0, c, seed >> 16) : _evilRanges(seed >> 16, t0, ref, band, c);
        IDeskTypes.Meta memory m = seed % 5 == 0 ? _evilMeta(seed >> 64, c) : _meta(_deadline(seed >> 64));
        int24 expected = seed % 7 == 0 ? t0 + int24(_randInt(seed >> 96, -20, 20)) : t0;
        uint24 delta = seed % 5 == 0 ? uint24((seed >> 104) % (uint256(c.maxTickDelta) + 8)) : c.maxTickDelta;
        _call(who, abi.encodeCall(IDeskLane.rerange, (m, r, expected, delta)));
        _attackerAfter(seed >> 120, t0);
    }

    /// @notice The operator key calls ANY lane selector: type-correct random arguments, or raw random bytes.
    function evilCall(uint256 which, uint256 seed, bytes calldata raw) external {
        seed = _mix(seed);
        which = _mix(which);
        bool isRaw = seed % 4 == 0;
        _begin(isRaw ? A_EVIL_RAW : A_EVIL_CALL);
        address who = mOperator == address(0) ? operator1 : mOperator;
        bytes memory data = isRaw ? abi.encodePacked(_selector(which), raw) : _randomCall(which, seed >> 8);
        int24 t0 = _tick();
        _call(who, data);
        _attackerAfter(seed >> 128, t0);
    }

    // ================================================================== attacker

    function attackerAct(uint256 seed, bytes calldata raw) external {
        seed = _mix(seed);
        uint256 k = seed % 10;
        uint256 s = seed >> 8;
        if (k < 2) {
            _begin(A_ATK_SWAP);
            _attackerSwap(s);
        } else if (k == 2) {
            _begin(A_ATK_DONATE);
            _donate(attacker, s);
        } else if (k == 3) {
            _begin(A_ATK_NFT);
            _sendNft(s);
        } else if (k == 4) {
            _begin(A_ATK_NPM);
            _npmAttack(s);
        } else if (k == 5) {
            _begin(A_ATK_INCREASE);
            _increaseLanePosition(s);
        } else if (k == 6) {
            _begin(A_ATK_CALLBACK);
            _spoofCallback(s);
        } else {
            _begin(A_ATK_LANE);
            bytes memory d = s % 3 == 0 ? abi.encodePacked(_selector(s >> 8), raw) : _randomCall(s >> 8, s >> 64);
            _call(attacker, d);
        }
    }

    // ================================================================== owner

    function ownerAct(uint256 seed) external {
        seed = _mix(seed);
        uint256 k = seed % 20;
        uint256 s = seed >> 8;
        if (k < 2) {
            _begin(A_OWN_WITHDRAW);
            address t = _pick3(s, token0, token1, junk);
            uint256 bal = IERC20(t).balanceOf(address(lane));
            uint256 amt = s % 9 == 0 ? bal + 1 : bal * (1 + (s >> 8) % 100) / 100;
            _call(owner, abi.encodeCall(IDeskLane.withdraw, (t, amt)));
        } else if (k == 2) {
            _begin(A_OWN_WITHDRAW_ALL);
            _call(owner, abi.encodeCall(IDeskLane.withdrawAll, ()));
        } else if (k == 3) {
            _begin(A_OWN_WITHDRAW_POS);
            _call(owner, abi.encodeCall(IDeskLane.withdrawPosition, (uint8(s % 3))));
        } else if (k == 4 && s % 3 == 0) {
            _begin(A_OWN_PAUSE);
            _call(owner, abi.encodeCall(IDeskLane.pause, ()));
        } else if (k < 8) {
            _begin(A_OWN_UNPAUSE);
            _call(owner, abi.encodeCall(IDeskLane.unpause, ()));
        } else if (k == 8) {
            _begin(A_OWN_TIGHTEN);
            _call(owner, abi.encodeCall(IDeskLane.setCaps, (_tighterCaps(s))));
        } else if (k < 11) {
            _begin(A_OWN_LOOSEN);
            _call(owner, abi.encodeCall(IDeskLane.setCaps, (_looserCaps(s))));
        } else if (k < 13) {
            _begin(A_OWN_APPLY_CAPS);
            // The owner usually comes back once the timelock is over.
            if (s % 4 != 0) _waitUntil(mPendingCapsEta, s >> 8);
            _call(owner, abi.encodeCall(IDeskLane.applyCaps, ()));
        } else if (k == 13) {
            _begin(A_OWN_CANCEL_CAPS);
            _call(owner, abi.encodeCall(IDeskLane.cancelCaps, ()));
        } else if (k == 14) {
            _begin(A_OWN_OPERATOR);
            _ownerOperator(s);
        } else if (k == 15) {
            _begin(A_OWN_GUARDIAN);
            _call(owner, abi.encodeCall(IDeskLane.setGuardian, (_pick3(s, guardian1, guardian2, address(0)))));
        } else if (k == 16) {
            _begin(A_OWN_CLOSED_UNTIL);
            uint256 v = s % 3;
            uint64 until =
                v == 0 ? 0 : v == 1 ? uint64(block.timestamp - 1) : uint64(block.timestamp + 1 + (s >> 8) % 8 hours);
            _call(owner, abi.encodeCall(IDeskLane.setClosedUntil, (until)));
        } else if (k < 19) {
            _begin(A_OWN_DEPOSIT);
            _donate(owner, s);
        } else {
            _begin(A_OWN_RERANGE);
            if (_openNow()) _waitForBudgets(s >> 200);
            _honestRerange(owner, s);
        }
    }

    // ================================================================== guardian

    function guardianAct(uint256 seed) external {
        seed = _mix(seed);
        address who = mGuardian != address(0) && seed % 8 != 0 ? mGuardian : (seed % 2 == 0 ? guardian1 : guardian2);
        uint256 k = (seed >> 8) % 8;
        uint256 s = seed >> 16;
        int24 t0 = _tick();
        if (k < 4) {
            _begin(A_GUARD_REDUCING);
            if (k == 0 && s % 4 == 0) _call(who, abi.encodeCall(IDeskLane.pause, ()));
            else if (k < 3 || k == 0) _call(who, abi.encodeCall(IDeskLane.exitAll, (_meta(_deadline(s)))));
            else _call(who, abi.encodeCall(IDeskLane.reduce, (_meta(_deadline(s)), uint8(s % 2), _someLiquidity(s))));
        } else if (k < 6) {
            _begin(A_GUARD_CLOSED_UNTIL);
            uint256 base = mClosedUntil > block.timestamp ? mClosedUntil : block.timestamp;
            uint64 until = k == 4 || mClosedUntil == 0
                ? uint64(base + (s >> 8) % 6 hours)
                : uint64(mClosedUntil - 1 - (s >> 8) % mClosedUntil); // shortening: must revert
            _call(who, abi.encodeCall(IDeskLane.setClosedUntil, (until)));
        } else {
            _begin(A_GUARD_FORBIDDEN);
            _call(who, _randomCall(_forbiddenForGuardian(s), s >> 8));
        }
        _attackerAfter(seed >> 128, t0);
    }

    // ================================================================== environment

    /// @notice Forward-only time: mostly minutes, sometimes a day or three (crossing the UTC weekend window).
    function warp(uint256 seed) external {
        seed = _mix(seed);
        _begin(A_WARP);
        uint256 r = seed % 100;
        uint256 dt = r < 60
            ? 1 + (seed >> 8) % 1 hours
            : r < 85 ? 1 hours + (seed >> 8) % 23 hours : 1 days + (seed >> 8) % 2 days;
        _advance(dt, seed >> 64);
    }

    /// @notice The market: arbitrage toward the fence price, a random walk around it, or fee-generating churn.
    function movePrice(uint256 seed) external {
        seed = _mix(seed);
        _begin(A_MOVE);
        int24 fair = _fairTick();
        int24 band = int24(uint24(mCaps.placeBandBps));
        uint256 k = seed % 10;
        if (k < 5) _moveTo(fair + int24(_randInt(seed >> 8, -int256(band) / 2, int256(band) / 2)));
        else if (k < 8) _moveTo(fair + int24(_randInt(seed >> 8, -3 * int256(band) - 30, 3 * int256(band) + 30)));
        else _churn(seed >> 8);
    }

    /// @notice Chainlink and issuer events: price steps (stock and quote), age, decimals, reverts, broken rounds,
    /// oraclePaused, corporate actions (uiMultiplier change + the feed step at effectiveAt), heal.
    function oracleAct(uint256 seed) external {
        seed = _mix(seed);
        uint256 k = seed % 14;
        uint256 s = seed >> 8;
        uint8 q = 1 - stock;
        if (k < 4) {
            _begin(A_CL_STOCK_STEP);
            uint256 p = env.feed(stock).price8 * uint256(10_000 + _randInt(s, -300, 300)) / 10_000;
            uint256 lo = stockPrice8AtStart * 7 / 10;
            uint256 hi = stockPrice8AtStart * 13 / 10;
            _priceStep(stock, p < lo ? lo : p > hi ? hi : p);
        } else if (k == 4) {
            _begin(A_CL_QUOTE_STEP);
            _priceStep(q, 1e8 * uint256(10_000 + _randInt(s, -80, 80)) / 10_000);
        } else if (k == 5) {
            _begin(A_CL_AGE);
            env.setUpdatedAt(uint8(s % 2), block.timestamp - (s >> 8) % 30 hours);
        } else if (k == 6) {
            _begin(A_CL_DECIMALS);
            uint8 i = uint8(s % 2);
            env.setDecimals(i, env.feed(i).decimals == 8 ? 18 : 8);
        } else if (k == 7) {
            _begin(A_CL_REVERT);
            uint8 i = uint8(s % 2);
            env.setReverting(i, !env.feed(i).reverting);
        } else if (k == 8) {
            _begin(A_CL_BROKEN);
            uint8 i = uint8(s % 2);
            uint256 v = (s >> 8) % 4;
            if (v == 0) env.setRaw(i, 0, block.timestamp);
            else if (v == 1) env.setRaw(i, -int256(1 + (s >> 16) % 1e8), block.timestamp);
            else if (v == 2) env.setRaw(i, env.feed(i).answer, block.timestamp + 1 + (s >> 16) % 1 hours);
            else env.heal(i);
        } else if (k == 9) {
            _begin(A_ORACLE_PAUSED);
            env.setOraclePaused(!env.oraclePaused());
        } else if (k < 12) {
            _begin(A_CORP_ACTION);
            uint256 at = uint256(int256(block.timestamp) + _randInt(s, -3 hours, 3 hours));
            corpRatioE18 = 1e18 * uint256(10_000 + _randInt(s >> 32, -100, 100)) / 10_000;
            env.setCorpAction(env.uiMultiplier() * corpRatioE18 / 1e18, at);
            corpAt = at;
            corpPending = true;
            _applyCorpStep();
        } else {
            _begin(A_CL_HEAL);
            env.heal(0);
            env.heal(1);
        }
    }

    /// @notice The issuer pauses or resumes a token (every transfer, mint and burn reverts while paused).
    function tokenAct(uint256 seed) external {
        seed = _mix(seed);
        _begin(A_TOKEN_PAUSE);
        if (seed % 4 == 0) {
            uint8 i = uint8((seed >> 8) % 2);
            env.setTokenPaused(i, !env.tokenPaused(i));
        } else {
            if (env.tokenPaused(0)) env.setTokenPaused(0, false);
            if (env.tokenPaused(1)) env.setTokenPaused(1, false);
        }
    }

    // ================================================================== scripted runs (not fuzz targets)

    /// @notice Forward time by exactly `dt` with the same heartbeat/recovery rules as `warp`.
    function advance(uint256 dt, uint256 seed) external {
        _begin(A_WARP);
        _advance(dt, _mix(seed));
    }

    /// @notice A stock Chainlink step of `bps` (an epoch boundary for I7, checked for I14).
    function stockStep(int256 bps) external {
        _begin(A_CL_STOCK_STEP);
        _priceStep(stock, env.feed(stock).price8 * uint256(10_000 + bps) / 10_000);
    }

    // ================================================================== checks (called by DeskInvariantBase)

    function firstViolation(uint256 i) external view returns (string memory) {
        return _first[i];
    }

    /// @notice I3: every decisionId the handler ever sent is spent exactly when (and only when) a call with it succeeded.
    function checkI3() external view returns (bool, string memory) {
        for (uint256 i; i < _ids.length; ++i) {
            bytes32 id = _ids[i];
            uint64 got = lane.decisionUsedAt(id);
            if (got != expectUsedAt[id]) {
                return (false, string.concat("decisionUsedAt(", vm.toString(id), ") = ", vm.toString(uint256(got))));
            }
        }
        return (true, "");
    }

    /// @notice I4: budgets() and the interval match the exact reference model within the lane's WAD rounding.
    function checkI4() external view returns (bool, string memory) {
        (uint256 turn, uint256 r1, uint256 r24, uint64 next) = lane.budgets();
        IDeskTypes.Caps memory c = mCaps;
        if (!_bucketMatches(turn, mTurn, c.turnoverUsd6PerDay, 1 days)) return (false, _bucketMsg("turnover", turn));
        if (!_bucketMatches(r1, mRr1h, c.reranges1h, 1 hours)) return (false, _bucketMsg("reranges1h", r1));
        if (!_bucketMatches(r24, mRr24h, c.reranges24h, 1 days)) return (false, _bucketMsg("reranges24h", r24));
        uint64 wantNext = mLastRerange == 0 ? 0 : mLastRerange + c.minRerangeInterval;
        if (next != wantNext || lane.lastRerangeAt() != mLastRerange) {
            return (false, "rerange interval model mismatch");
        }
        return (true, "");
    }

    /// @notice I5: no allowance from the lane survives any call.
    function checkI5() external view returns (bool, string memory) {
        address[3] memory tokens = [token0, token1, junk];
        address[10] memory spenders = [
            address(npm),
            address(pool),
            attacker,
            owner,
            operator1,
            operator2,
            guardian1,
            guardian2,
            address(mover),
            decoyPool
        ];
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < 10; ++j) {
                if (IERC20(tokens[i]).allowance(address(lane), spenders[j]) != 0) {
                    return (false, string.concat("lane allowance to ", vm.toString(spenders[j])));
                }
            }
        }
        return (true, "");
    }

    /// @notice I6: every tracked position is on the lane's own pool (same tokens and fee).
    function checkI6() external view returns (bool, string memory) {
        uint256[2] memory t = lane.positions();
        for (uint256 i; i < 2; ++i) {
            if (t[i] == 0) continue;
            (,, address a, address b, uint24 f,,,,,,,) = npm.positions(t[i]);
            if (a != token0 || b != token1 || f != fee) return (false, "a tracked position is not on the lane pool");
        }
        return (true, "");
    }

    /// @notice I7: fence-valued P&L >= -(band x notional of every mint + exposure created by price steps and donated
    /// liquidity) - rounding.
    function checkI7() external view returns (bool, string memory) {
        (int256 g, uint256 allowance) = boundedLoss();
        if (g + int256(allowance) >= 0) return (true, "");
        return
            (false, string.concat("fence-valued loss ", vm.toString(-g), " usd6 > allowance ", vm.toString(allowance)));
    }

    /// @notice I8: the lane's config is exactly what the owner (and guardian, within its powers) set.
    function checkI8() external view returns (bool, string memory) {
        if (lane.owner() != owner) return (false, "owner changed");
        if (lane.operator() != mOperator) return (false, "operator differs from the model");
        if (lane.guardian() != mGuardian) return (false, "guardian differs from the model");
        if (lane.paused() != mPaused) return (false, "paused differs from the model");
        if (lane.closedUntil() != mClosedUntil) return (false, "closedUntil differs from the model");
        if (keccak256(abi.encode(lane.caps())) != keccak256(abi.encode(mCaps))) {
            return (false, "caps differ from the model");
        }
        (address po, uint64 poEta) = lane.pendingOperator();
        if (po != mPendingOp || poEta != mPendingOpEta) return (false, "pending operator differs from the model");
        (IDeskTypes.Caps memory pc, uint64 pcEta) = lane.pendingCaps();
        if (pcEta != mPendingCapsEta || keccak256(abi.encode(pc)) != keccak256(abi.encode(mPendingCaps))) {
            return (false, "pending caps differ from the model");
        }
        return (true, "");
    }

    /// @notice I12: tracked slots are exactly the lane-owned NPM positions the lane minted (attacker-planted ones
    /// aside), with no duplicates and at most 2.
    function checkI12() external view returns (bool, string memory) {
        uint256[2] memory t = lane.positions();
        uint256 tracked;
        for (uint256 i; i < 2; ++i) {
            if (t[i] == 0) continue;
            tracked++;
            if (_isForeign[t[i]]) return (false, "a foreign NFT is tracked");
            if (npm.ownerOf(t[i]) != address(lane)) return (false, "a tracked position is not owned by the lane");
        }
        if (t[0] != 0 && t[0] == t[1]) return (false, "duplicate tracked position");
        uint256 foreignHeld;
        for (uint256 i; i < _foreign.length; ++i) {
            if (_ownerOrZero(_foreign[i]) == address(lane)) foreignHeld++;
        }
        uint256 held = npm.balanceOf(address(lane));
        if (held != tracked + foreignHeld) {
            return (false, string.concat("lane holds ", vm.toString(held), " NFTs, tracks ", vm.toString(tracked)));
        }
        return (true, "");
    }

    /// @notice I14 (and the fence model behind I11): refTick(), riskAddingOpen() and the fence codes equal the
    /// independent model, which prices from the feeds alone (a uiMultiplier change never moves the tick by itself).
    function checkI14() external view returns (bool, string memory) {
        IPriceFence f = IPriceFence(lane.fence());
        for (uint8 i; i < 2; ++i) {
            uint8 want = _code(i);
            if (f.status(env.token(i)) != want) {
                return (
                    false,
                    string.concat(
                        "fence status of token", vm.toString(uint256(i)), " != model ", vm.toString(uint256(want))
                    )
                );
            }
        }
        string memory why = _refTickMismatch();
        if (bytes(why).length != 0) return (false, why);
        (bool open, uint8 oc) = lane.riskAddingOpen();
        uint8 c0 = _code(0);
        uint8 wantOc = mPaused ? 100 : mClosedUntil > block.timestamp ? 101 : c0 != 0 ? c0 : _code(1);
        if (oc != wantOc || open != (wantOc == 0)) return (false, "riskAddingOpen != model");
        return (true, "");
    }

    function _refTickMismatch() internal view returns (string memory) {
        (int24 tick, int24 band, uint8 code) = lane.refTick();
        (int24 mTick, bool ok) = _modelRef();
        uint8 c0 = _code(0);
        uint8 wantCode = c0 != 0 ? c0 : _code(1);
        if (!ok && wantCode == 0) wantCode = 2;
        if (code != wantCode) return "refTick code != model";
        if (band != int24(uint24(mCaps.placeBandBps))) return "refTick band != placeBandBps";
        if (ok && tick != mTick) {
            return string.concat("refTick ", vm.toString(int256(tick)), " != model ", vm.toString(int256(mTick)));
        }
        return "";
    }

    /// @notice I9: exitAll from the current state succeeds within 3M gas (state rolled back).
    function exitLiveness() external returns (bool ok, uint256 gasUsed) {
        uint256 snap = vm.snapshotState();
        bytes memory data = abi.encodeCall(IDeskLane.exitAll, (_meta(uint64(block.timestamp))));
        vm.prank(owner);
        uint256 g0 = gasleft();
        (ok,) = address(lane).call{gas: EXIT_GAS}(data);
        gasUsed = g0 - gasleft();
        vm.revertToState(snap);
    }

    /// @notice I2: with the fence broken (feeds reverting, oraclePaused, closedUntil, lane paused) and the stock
    /// token paused, exitAll + withdrawAll + withdrawPosition still recover everything recoverable; then the same with
    /// everything healthy. State is rolled back. Returns "" or the first failure.
    function ownerCanAlwaysExit() external returns (string memory failure) {
        uint256 snap = vm.snapshotState();
        failure = _exitDrill(true);
        vm.revertToState(snap);
        if (bytes(failure).length != 0) return string.concat("broken fence: ", failure);
        snap = vm.snapshotState();
        failure = _exitDrill(false);
        vm.revertToState(snap);
        if (bytes(failure).length != 0) return string.concat("healthy: ", failure);
    }

    /// @notice Fence-valued P&L so far (usd6) and the loss it may show under I7.
    function boundedLoss() public view returns (int256 g, uint256 allowance) {
        g = pnlClosed + int256(nav() + epochOut) - int256(epochStartNav + epochIn);
        allowance = lossBudget + slack + 20;
    }

    /// @notice The lane's value at the fair (fence) prices, usd6: idle token0/token1 plus every tracked position
    /// (principal at the pool price + tokens owed). Uncollected fees are left out, which only makes I7 stricter.
    function nav() public view returns (uint256 v) {
        (uint160 s,,,,,,) = pool.slot0();
        uint256 p0 = env.priceE18(0);
        uint256 p1 = env.priceE18(1);
        v = LaneMath.usd6(IERC20(token0).balanceOf(address(lane)), p0, dec0)
            + LaneMath.usd6(IERC20(token1).balanceOf(address(lane)), p1, dec1);
        uint256[2] memory t = lane.positions();
        for (uint256 i; i < 2; ++i) {
            if (t[i] != 0) v += _positionUsd(t[i], s, p0, p1);
        }
    }

    function idsLength() external view returns (uint256) {
        return _ids.length;
    }

    function idAt(uint256 i) external view returns (bytes32) {
        return _ids[i];
    }

    function foreignCount() external view returns (uint256) {
        return _foreign.length;
    }

    /// @notice One JSON object with this run's counters (DeskInvariantBase appends it to DESK_INVARIANT_LOG).
    function statsJson() external view returns (string memory j) {
        j = string.concat(
            '{"calls":', _arr(actCalls), ',"laneOk":', _arr(actLaneOk), ',"laneReverts":', _arr(actLaneReverts)
        );
        j = string.concat(j, ',"violations":[');
        for (uint256 i = 1; i < 15; ++i) {
            j = string.concat(j, i == 1 ? "" : ",", vm.toString(violations[i]));
        }
        j = string.concat(j, '],"revertsBy":{');
        for (uint256 i; i < _revertSels.length; ++i) {
            j = string.concat(
                j,
                i == 0 ? '"' : ',"',
                vm.toString(abi.encodePacked(_revertSels[i])),
                '":',
                vm.toString(revertsBy[_revertSels[i]])
            );
        }
        (int256 g, uint256 allowance) = boundedLoss();
        j = string.concat(j, '},"riskReranges":', vm.toString(riskReranges), ',"mints":', vm.toString(mints));
        j = string.concat(j, ',"priceSteps":', vm.toString(priceSteps), ',"corpSteps":', vm.toString(corpSteps));
        j = string.concat(j, ',"donations":', vm.toString(donations), ',"foreignNfts":', vm.toString(_foreign.length));
        j = string.concat(j, ',"decisionIds":', vm.toString(_ids.length), ',"turnoverUsd6":', vm.toString(turnoverUsed));
        j = string.concat(j, ',"pnlUsd6":', vm.toString(g), ',"allowanceUsd6":', vm.toString(allowance));
        j = string.concat(j, ',"maxExitGas":', vm.toString(maxExitGas), ',"maxMintDevBps":', vm.toString(maxMintDevBps));
        j = string.concat(
            j,
            ',"maxLossOfBudgetBps":',
            vm.toString(maxLossOfBudgetBps),
            ',"lossBudgetUsd6":',
            vm.toString(lossBudget),
            "}"
        );
    }

    /// @notice Record the exitAll gas of the final state (for the report; not an invariant).
    function recordExitGas(uint256 gasUsed) external {
        if (gasUsed > maxExitGas) maxExitGas = gasUsed;
    }

    // ================================================================== internal: actors

    function _honestRerange(address who, uint256 seed) internal {
        IDeskTypes.Caps memory c = mCaps;
        if (c.maxRanges == 0) return;
        int24 t0 = _tick();
        int24 ref = _refOrFair();
        int24 band = int24(uint24(c.placeBandBps));
        int24 half = _halfWidth(c, seed);
        uint16 share = _share(c, seed >> 32);
        if (half == 0 || share == 0) return;
        IDeskTypes.RangeSpec[] memory r = _honestRanges(t0, ref, band, half, share, c.maxRanges, seed >> 64);
        // The attacker moves the pool between the agent's read and its transaction.
        if (seed % 3 == 0) _moveTo(t0 + int24(_randInt(seed >> 72, -15, 15)));
        IDeskTypes.Meta memory m = _meta(uint64(block.timestamp + _min(60, c.maxDeadlineAhead)));
        _call(who, abi.encodeCall(IDeskLane.rerange, (m, r, t0, c.maxTickDelta)));
        _attackerAfter(seed >> 96, t0);
    }

    /// @dev A straddle when the pool is within the band of the reference, else one or two single-sided ranges on the
    /// sides the fence allows.
    function _honestRanges(int24 t0, int24 ref, int24 band, int24 half, uint16 share, uint8 maxRanges, uint256 seed)
        internal
        view
        returns (IDeskTypes.RangeSpec[] memory r)
    {
        int24 sp = spacing;
        if (t0 >= ref - band && t0 <= ref + band) {
            r = new IDeskTypes.RangeSpec[](1);
            r[0] =
                IDeskTypes.RangeSpec(LaneMath.floorTick(t0 - half, sp), LaneMath.ceilTick(t0 + half, sp), share, share);
            return r;
        }
        IDeskTypes.RangeSpec memory ask; // token0 only, above the pool
        IDeskTypes.RangeSpec memory bid; // token1 only, below the pool
        if (t0 > ref + band) {
            int24 tl = LaneMath.ceilTick(t0 + 1, sp);
            ask = IDeskTypes.RangeSpec(tl, tl + 2 * half, share, 0);
            int24 tu = LaneMath.floorTick(ref + band, sp);
            bid = IDeskTypes.RangeSpec(tu - 2 * half, tu, 0, share);
        } else {
            int24 tu = LaneMath.floorTick(t0, sp);
            bid = IDeskTypes.RangeSpec(tu - 2 * half, tu, 0, share);
            int24 tl = LaneMath.ceilTick(ref - band, sp);
            ask = IDeskTypes.RangeSpec(tl, tl + 2 * half, share, 0);
        }
        if (maxRanges >= 2) {
            r = new IDeskTypes.RangeSpec[](2);
            (r[0], r[1]) = (ask, bid);
        } else {
            r = new IDeskTypes.RangeSpec[](1);
            r[0] = seed % 2 == 0 ? ask : bid;
        }
    }

    function _reducing(address who, uint256 seed) internal {
        uint256 k = seed % 7;
        uint256 s = seed >> 8;
        int24 t0 = _tick();
        IDeskTypes.Meta memory m = _meta(_deadline(s));
        if (k == 0) _call(who, abi.encodeCall(IDeskLane.collect, (m)));
        else if (k < 3) _call(who, abi.encodeCall(IDeskLane.reduce, (m, uint8(s % 2), _someLiquidity(s))));
        else if (k == 3) _call(who, abi.encodeCall(IDeskLane.exitAll, (m)));
        else if (k == 4) _call(who, abi.encodeCall(IDeskLane.rerange, (m, new IDeskTypes.RangeSpec[](0), t0, 0)));
        else if (k == 5) _call(who, abi.encodeCall(IDeskLane.signal, (m)));
        else if (s % 16 == 0) _call(who, abi.encodeCall(IDeskLane.pause, ()));
        else _call(who, abi.encodeCall(IDeskLane.collect, (m)));
        _attackerAfter(seed >> 128, t0);
    }

    /// @dev Right after an operator action the attacker arbitrages to the fence price (the lane's worst case), walks
    /// the pool nearby, closes the sandwich, or does nothing.
    function _attackerAfter(uint256 seed, int24 before) internal {
        uint256 k = seed % 4;
        if (k == 0) {
            _moveTo(_fairTick());
        } else if (k == 1) {
            _moveTo(
                _fairTick()
                    + int24(
                        _randInt(seed >> 8, -int256(uint256(mCaps.placeBandBps)), int256(uint256(mCaps.placeBandBps)))
                    )
            );
        } else if (k == 2) {
            _moveTo(before);
        }
    }

    function _attackerSwap(uint256 seed) internal {
        uint256 k = seed % 3;
        int24 band = int24(uint24(mCaps.placeBandBps));
        if (k == 0) _moveTo(_fairTick() + int24(_randInt(seed >> 8, -3 * int256(band), 3 * int256(band))));
        else if (k == 1) _moveTo(_fairTick());
        else _churn(seed >> 8);
    }

    function _churn(uint256 seed) internal {
        _fundMover();
        vm.recordLogs();
        bool zeroForOne = seed % 2 == 0;
        uint256 amt = zeroForOne ? 1e6 + (seed >> 8) % (dec0 == 6 ? 50_000e6 : 50_000e18) : 1e15 + (seed >> 8) % 200e18;
        try mover.swapExactIn(zeroForOne, amt) {} catch {}
        try mover.swapExactIn(!zeroForOne, zeroForOne ? amt / 1e6 * 1e18 / 230 : amt * 220 / 1e12) {} catch {}
        _auditExternal(vm.getRecordedLogs());
    }

    /// @dev Donation (attacker) or deposit (owner) of token0/token1/junk straight to the lane.
    function _donate(address from, uint256 seed) internal {
        address t = _pick3(seed, token0, token1, junk);
        uint256 amt = t == token0 ? 1 + (seed >> 8) % 30e6 : 1 + (seed >> 8) % 0.15e18;
        env.fund(t, from, amt);
        vm.recordLogs();
        vm.prank(from);
        (bool ok,) = t.call(abi.encodeCall(IERC20.transfer, (address(lane), amt)));
        if (ok) donations++;
        _auditExternal(vm.getRecordedLogs());
    }

    /// @dev Foreign NFTs: safeTransferFrom must bounce (no onERC721Received); plain transfers and NPM mints to the lane
    /// land but are never tracked.
    function _sendNft(uint256 seed) internal {
        uint256 k = seed % 3;
        address p = k == 2 && decoyPool != address(0) ? decoyPool : address(pool);
        address to = k == 0 ? attacker : address(lane);
        uint256 id = _attackerMint(p, to, seed >> 8);
        if (id == 0 || k != 0) return;
        vm.recordLogs();
        vm.prank(attacker);
        try npm.safeTransferFrom(attacker, address(lane), id) {
            _violate(12, "the lane accepted an NFT through safeTransferFrom");
        } catch {}
        if ((seed >> 16) % 2 == 0) {
            vm.prank(attacker);
            try npm.transferFrom(attacker, address(lane), id) {} catch {}
        }
        _auditExternal(vm.getRecordedLogs());
    }

    function _attackerMint(address p, address to, uint256 seed) internal returns (uint256 id) {
        (, int24 t,,,,,) = IUniswapV3PoolTest(p).slot0();
        int24 sp = IUniswapV3PoolTest(p).tickSpacing();
        uint24 f = IUniswapV3PoolTest(p).fee();
        uint256 a0 = 1e6 + (seed % 5e6);
        uint256 a1 = 1e15 + ((seed >> 32) % 0.02e18);
        env.fund(token0, attacker, a0);
        env.fund(token1, attacker, a1);
        vm.recordLogs();
        vm.prank(attacker);
        try npm.mint(
            INPM.MintParams(
                token0,
                token1,
                f,
                LaneMath.floorTick(t - 200, sp),
                LaneMath.ceilTick(t + 200, sp),
                a0,
                a1,
                0,
                0,
                to,
                block.timestamp
            )
        ) returns (
            uint256 tokenId, uint128, uint256, uint256
        ) {
            id = tokenId;
        } catch {}
        _auditExternal(vm.getRecordedLogs());
    }

    /// @dev The attacker calls the NPM directly on a lane position: every attempt must revert.
    function _npmAttack(uint256 seed) internal {
        uint256 id = _someTracked(seed);
        if (id == 0) return;
        uint256 k = (seed >> 8) % 6;
        bytes memory data;
        if (k == 0) {
            data = abi.encodeCall(INPM.decreaseLiquidity, (INPM.DecreaseLiquidityParams(id, 1, 0, 0, block.timestamp)));
        } else if (k == 1) {
            data =
                abi.encodeCall(INPM.collect, (INPM.CollectParams(id, attacker, type(uint128).max, type(uint128).max)));
        } else if (k == 2) {
            data = abi.encodeCall(INPM.burn, (id));
        } else if (k == 3) {
            data = abi.encodeCall(INPM.approve, (attacker, id));
        } else if (k == 4) {
            data = abi.encodeCall(INPM.transferFrom, (address(lane), attacker, id));
        } else {
            data = abi.encodeCall(INPM.safeTransferFrom, (address(lane), attacker, id));
        }
        vm.recordLogs();
        vm.prank(attacker);
        (bool ok,) = address(npm).call(data);
        if (ok) {
            _violate(1, string.concat("the attacker's NPM call succeeded on a lane position, kind ", vm.toString(k)));
        }
        _auditExternal(vm.getRecordedLogs());
    }

    /// @dev Anyone may add liquidity to any NPM position: a donation to the lane, audited as an inflow.
    function _increaseLanePosition(uint256 seed) internal {
        uint256 id = _someTracked(seed);
        if (id == 0) return;
        uint256 a0 = 1 + (seed >> 8) % 10e6;
        uint256 a1 = 1 + (seed >> 40) % 0.05e18;
        env.fund(token0, attacker, a0);
        env.fund(token1, attacker, a1);
        vm.recordLogs();
        vm.prank(attacker);
        try INPMAttack(address(npm))
            .increaseLiquidity(INPMAttack.IncreaseLiquidityParams(id, a0, a1, 0, 0, block.timestamp)) {
            donations++;
        } catch {}
        _auditExternal(vm.getRecordedLogs());
    }

    /// @dev A spoofed NPM mint callback that names the lane as payer: the NPM must reject a non-pool caller.
    function _spoofCallback(uint256 seed) internal {
        bytes memory cb = abi.encode(token0, token1, fee, address(lane));
        vm.recordLogs();
        vm.prank(attacker);
        try INPMAttack(address(npm)).uniswapV3MintCallback(1 + seed % 1e6, 1 + (seed >> 32) % 1e15, cb) {
            _violate(1, "a spoofed mint callback was accepted");
        } catch {}
        _auditExternal(vm.getRecordedLogs());
    }

    function _ownerOperator(uint256 s) internal {
        uint256 k = s % 10;
        if (k < 4) {
            address next = mOperator == operator1 ? operator2 : operator1;
            if (k == 3 && (s >> 8) % 4 == 0) next = (s >> 16) % 2 == 0 ? owner : address(0); // must revert
            _call(owner, abi.encodeCall(IDeskLane.proposeOperator, (next)));
        } else if (k < 9) {
            if (s % 4 != 0) _waitUntil(mPendingOpEta, s >> 8);
            _call(owner, abi.encodeCall(IDeskLane.applyOperator, ()));
        } else if ((s >> 8) % 4 == 0) {
            _call(owner, abi.encodeCall(IDeskLane.revokeOperator, ()));
        }
    }

    // ================================================================== internal: environment

    function _advance(uint256 dt, uint256 seed) internal {
        vm.warp(block.timestamp + dt);
        // Limits must not depend on block.number (an L1 estimate on Orbit): roll it anywhere, even backwards.
        if (fork) vm.roll(block.number + dt * 10);
        else vm.roll(uint256(keccak256(abi.encode(seed, "roll"))) % 1e10);
        // Heartbeat: the quote feed updates around the clock, the stock feed only in the 24/5 session.
        if (seed % 5 != 0) {
            for (uint8 i; i < 2; ++i) {
                if (!env.feedSound(i)) continue;
                if (i == stock && LaneMath.stockWeekend(block.timestamp)) continue;
                env.setUpdatedAt(i, block.timestamp - (seed >> 8) % 600);
            }
        }
        // Oracle incidents resolve over time.
        if ((seed >> 28) % 3 == 0) {
            if (env.oraclePaused()) env.setOraclePaused(false);
            for (uint8 i; i < 2; ++i) {
                if (!env.feedSound(i)) env.heal(i);
            }
        }
        // The owner re-arms a paused lane after reviewing it.
        if (mPaused && (seed >> 24) % 2 == 0) _call(owner, abi.encodeCall(IDeskLane.unpause, ()));
        // The issuer resumes transfers.
        if ((seed >> 20) % 2 == 0) {
            if (env.tokenPaused(0)) env.setTokenPaused(0, false);
            if (env.tokenPaused(1)) env.setTokenPaused(1, false);
        }
        _applyCorpStep();
    }

    /// @dev Forward to `eta` when it is pending and at most two days away.
    function _waitUntil(uint64 eta, uint256 seed) internal {
        if (eta > block.timestamp && eta - block.timestamp <= 2 days) _advance(eta - block.timestamp, seed);
    }

    /// @dev The honest agent waits (forward only, at most an hour) for the interval and the rerange buckets.
    function _waitForBudgets(uint256 seed) internal {
        IDeskTypes.Caps memory c = mCaps;
        uint256 wait;
        uint256 next = uint256(mLastRerange) + c.minRerangeInterval;
        if (next > block.timestamp) wait = next - block.timestamp;
        uint256 w1 = _refillWait(mRr1h, c.reranges1h, 1 hours);
        uint256 w24 = _refillWait(mRr24h, c.reranges24h, 1 days);
        if (w1 > wait) wait = w1;
        if (w24 > wait) wait = w24;
        if (wait != 0 && wait <= 1 hours) _advance(wait, seed);
    }

    function _refillWait(MBucket storage b, uint256 cap, uint256 period) internal view returns (uint256) {
        if (cap == 0) return type(uint256).max;
        uint256 lvl = _level(b, cap, period, block.timestamp);
        if (lvl >= period) return 0;
        return Math.ceilDiv(period - lvl, cap) + 1;
    }

    /// @dev A fence price step: close the constant-price epoch, change the feed, open the next epoch and charge the
    /// exposure the step created on live positions. I14: the lane's refTick moves exactly as the feeds do.
    function _priceStep(uint8 i, uint256 price8) internal {
        (int24 lane0,,) = lane.refTick();
        (int24 m0, bool ok0) = _modelRef();
        _closeEpoch();
        env.setPrice8(i, price8);
        _openEpoch();
        priceSteps++;
        (int24 lane1,,) = lane.refTick();
        (int24 m1, bool ok1) = _modelRef();
        if (ok0 && ok1 && int256(lane1) - lane0 != int256(m1) - m0) {
            _violate(14, "a feed step moved refTick differently from the feed ratio");
        }
    }

    /// @dev At effectiveAt the stock feed publishes the multiplier-adjusted price (once).
    function _applyCorpStep() internal {
        if (!corpPending || block.timestamp < corpAt) return;
        corpPending = false;
        corpSteps++;
        _priceStep(stock, env.feed(stock).price8 * corpRatioE18 / 1e18);
    }

    function _closeEpoch() internal {
        pnlClosed += int256(nav() + epochOut) - int256(epochStartNav + epochIn);
        slack += 4;
    }

    function _openEpoch() internal {
        epochStartNav = nav();
        epochIn = 0;
        epochOut = 0;
        (uint160 s,,,,,,) = pool.slot0();
        uint256[2] memory t = lane.positions();
        for (uint256 k; k < 2; ++k) {
            if (t[k] == 0) continue;
            (,,,,, int24 tl, int24 tu, uint128 liq,,,,) = npm.positions(t[k]);
            lossBudget += _dev(tl, tu, liq, s, env.priceE18(0), env.priceE18(1)) + 3;
        }
        slack += 4;
    }

    function _moveTo(int24 target) internal {
        _moveWithin(target, 1500);
    }

    /// @dev Move the pool to `target`, clamped to `reach` ticks around the fair (fence) tick.
    function _moveWithin(int24 target, int24 reach) internal {
        int24 fair = _fairTick();
        if (target > fair + reach) target = fair + reach;
        if (target < fair - reach) target = fair - reach;
        _fundMover();
        vm.recordLogs();
        try mover.moveTo(target) {} catch {}
        _auditExternal(vm.getRecordedLogs());
    }

    /// @dev Park the pool 200-3,200 ticks beyond the band: above the reference at the TOP of an aligned tick tc (so a
    /// range [tc, tc + w) holds a sliver of token1 bidding at the manipulated price), or below it at the BOTTOM of
    /// the tick just under an aligned tu (so [tu - w, tu) offers a sliver of token0 there).
    function _parkFar(int24 ref, int24 band, uint256 s) internal {
        int24 d = band + 200 + int24(_randInt(s >> 8, 0, 3000));
        if (s % 2 == 0) {
            int24 tc = LaneMath.floorTick(ref + d, spacing);
            _moveWithin(tc + 50, 4000);
            _moveWithin(tc, 4000); // from above: just under the upper edge of tc
        } else {
            int24 tu = LaneMath.floorTick(ref - d, spacing);
            _moveWithin(tu - 50, 4000);
            _moveWithin(tu - 1, 4000); // from below: at the lower edge of tu - 1
        }
    }

    /// @dev One range whose in-range edge is the pool tick: [t0, t0 + w) when t0 is aligned, [t0 + 1 - w, t0 + 1) when
    /// t0 + 1 is, else a straddle of the pool's aligned tick.
    function _atPoolTick(int24 t0, IDeskTypes.Caps memory c, uint256 s)
        internal
        view
        returns (IDeskTypes.RangeSpec[] memory r)
    {
        int24 w = _evilWidth(s >> 8, c);
        r = new IDeskTypes.RangeSpec[](1);
        if ((t0 + 1) % spacing == 0) {
            r[0].tickLower = t0 + 1 - w;
            r[0].tickUpper = t0 + 1;
        } else {
            r[0].tickLower = LaneMath.floorTick(t0, spacing);
            r[0].tickUpper = r[0].tickLower + w;
        }
        r[0].share0Bps = uint16((s >> 40) % 2 == 0 ? 10_000 : (s >> 48) % 10_001);
        r[0].share1Bps = uint16((s >> 64) % 2 == 0 ? 10_000 : (s >> 72) % 10_001);
    }

    /// @dev On a fork the mover cannot mint: keep it stocked through the env (balance-slot writes).
    function _fundMover() internal {
        if (!fork) return;
        uint256 low0 = 10 ** uint256(dec0) * 5_000_000;
        uint256 low1 = 10 ** uint256(dec1) * 25_000;
        if (IERC20(token0).balanceOf(address(mover)) < low0) env.fund(token0, address(mover), 4 * low0);
        if (IERC20(token1).balanceOf(address(mover)) < low1) env.fund(token1, address(mover), 4 * low1);
    }

    // ================================================================== internal: lane calls and the log auditor

    struct Pre {
        uint256 ts;
        uint160 sqrtP;
        int24 tick;
        bool paused;
        uint64 closedUntil;
        uint8 code0;
        uint8 code1;
        uint256 p0;
        uint256 p1;
        address op;
        address guard;
        IDeskTypes.Caps caps;
    }

    struct Audit {
        uint256 flowIn;
        uint256 flowOut;
        uint256 budget;
        uint256 slack;
        uint256 notional; // usd6 the lane charges: each token's TOTAL minted amount valued and rounded up (spec step 9)
        uint256 used0;
        uint256 used1;
        uint256[4] newIds;
        uint256 nNew;
        uint256 toPool0;
        uint256 toPool1;
        uint256 inc0;
        uint256 inc1;
    }

    /// @dev Seeds from the fuzzer's dictionary are often tiny or repeated; every choice here is `seed % n`, so mix
    /// them (deterministically: the sequence number is state) to keep the choices uniform.
    function _mix(uint256 seed) internal returns (uint256) {
        return uint256(keccak256(abi.encode(seed, ++_seq)));
    }

    function _begin(uint8 a) internal {
        _act = a;
        actCalls[a]++;
        env.sync();
        (int256 g, uint256 allowance) = boundedLoss();
        if (g < 0 && uint256(-g) * 10_000 / allowance > maxLossOfBudgetBps) {
            maxLossOfBudgetBps = uint256(-g) * 10_000 / allowance;
        }
    }

    function _pre() internal view returns (Pre memory p) {
        p.ts = block.timestamp;
        (p.sqrtP, p.tick,,,,,) = pool.slot0();
        p.paused = mPaused;
        p.closedUntil = mClosedUntil;
        p.code0 = _code(0);
        p.code1 = _code(1);
        p.p0 = env.priceE18(0);
        p.p1 = env.priceE18(1);
        p.op = mOperator;
        p.guard = mGuardian;
        p.caps = mCaps;
    }

    /// @dev Every lane call: recorded, audited, and fed to the models.
    function _call(address who, bytes memory data) internal returns (bool ok, bytes memory ret) {
        Pre memory pre = _pre();
        delete _lastTicks;
        vm.recordLogs();
        vm.prank(who);
        (ok, ret) = address(lane).call(data);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes4 sel = data.length >= 4 ? bytes4(data) : bytes4(0);
        _stat(ok, ret);
        Audit memory au = _auditLane(logs, pre, who, sel, ok);
        if (_takesMeta(sel)) _trackDecision(data, ok, pre);
        if (ok && !_allowed(who, sel, pre)) {
            _violate(8, string.concat(_role(who, pre), " succeeded with selector ", vm.toString(abi.encodePacked(sel))));
        }
        if (ok) _modelConfig(who, sel, data, pre);
        if (sel == IDeskLane.rerange.selector) _modelRerange(data, ok, ret, pre, au);
        epochIn += au.flowIn;
        epochOut += au.flowOut;
        lossBudget += au.budget;
        slack += au.slack;
    }

    function _auditLane(Vm.Log[] memory logs, Pre memory pre, address who, bytes4 sel, bool ok)
        internal
        returns (Audit memory au)
    {
        if (!ok) return au; // a reverted call leaves no logs
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.topics.length == 0) continue;
            bytes32 t = l.topics[0];
            if (t == TRANSFER) {
                _auditLaneTransfer(l, au, pre, who, sel);
            } else if (t == APPROVAL) {
                _auditApproval(l);
            } else if (t == APPROVAL_FOR_ALL) {
                if (_addr(l.topics[1]) == address(lane)) _violate(5, "the lane set an ApprovalForAll");
            } else if (t == NPM_INCREASE && l.emitter == address(npm)) {
                _auditIncrease(l, au, pre);
            } else if (t == NPM_COLLECT && l.emitter == address(npm)) {
                (address r,,) = abi.decode(l.data, (address, uint256, uint256));
                if (r != address(lane)) _violate(1, "an NPM collect of a lane position paid someone else");
            } else if (t == POOL_MINT && l.emitter != address(pool)) {
                _violate(6, string.concat("the lane minted liquidity in ", vm.toString(l.emitter)));
            } else if (l.emitter == address(lane)) {
                if (t == IDeskLane.LaneAction.selector) _auditLaneAction(l, pre, who);
                else if (t == IDeskLane.PositionMinted.selector) _auditMint(l, pre, au);
            }
        }
        if (au.toPool0 != au.inc0 || au.toPool1 != au.inc1) {
            _violate(1, "tokens sent to the pool differ from the amounts the lane's positions received");
        }
        au.notional = LaneMath.usd6Up(au.used0, pre.p0, dec0) + LaneMath.usd6Up(au.used1, pre.p1, dec1);
        for (uint256 k; k < au.nNew; ++k) {
            _auditNewPosition(au.newIds[k]);
        }
    }

    /// @dev I1: an ERC-20 leaves the lane only to the owner (owner withdraw) or to the lane pool inside an NPM mint of
    /// a position the lane then owns; an NFT leaves only to the owner (withdrawPosition) or burns.
    function _auditLaneTransfer(Vm.Log memory l, Audit memory au, Pre memory pre, address who, bytes4 sel) internal {
        address from = _addr(l.topics[1]);
        address to = _addr(l.topics[2]);
        if (l.topics.length == 3) {
            uint256 v = abi.decode(l.data, (uint256));
            if (from == address(lane)) {
                bool ownerExit = to == owner && who == owner
                    && (sel == IDeskLane.withdraw.selector || sel == IDeskLane.withdrawAll.selector);
                if (ownerExit) {
                    au.flowOut += _usd(l.emitter, v, pre.p0, pre.p1);
                } else if (to == address(pool) && l.emitter == token0) {
                    au.toPool0 += v;
                } else if (to == address(pool) && l.emitter == token1) {
                    au.toPool1 += v;
                } else {
                    _violate(1, string.concat("an ERC-20 left the lane to ", vm.toString(to)));
                }
            } else if (to == address(lane) && from != address(pool)) {
                au.flowIn += _usd(l.emitter, v, pre.p0, pre.p1);
            }
        } else if (l.topics.length == 4) {
            uint256 id = uint256(l.topics[3]);
            if (from == address(lane)) {
                bool burn = to == address(0) && l.emitter == address(npm);
                bool hatch = to == owner && who == owner && sel == IDeskLane.withdrawPosition.selector
                    && l.emitter == address(npm);
                if (!burn && !hatch) _violate(1, string.concat("an NFT left the lane to ", vm.toString(to)));
                if (hatch) au.flowOut += _positionUsd(id, pre.sqrtP, pre.p0, pre.p1);
            } else if (from == address(0) && to == address(lane) && l.emitter == address(npm)) {
                if (au.nNew < 4) au.newIds[au.nNew++] = id;
            }
        }
    }

    function _auditApproval(Vm.Log memory l) internal {
        if (_addr(l.topics[1]) != address(lane)) return;
        if (l.topics.length == 3 && _addr(l.topics[2]) != address(npm)) {
            _violate(5, "the lane approved a spender other than the NPM");
        }
        if (l.topics.length == 4 && _addr(l.topics[2]) != address(0)) _violate(5, "the lane approved its NFT");
    }

    /// @dev I11: liquidity is added only to a position this call minted, and only while risk-adding is open.
    function _auditIncrease(Vm.Log memory l, Audit memory au, Pre memory pre) internal {
        uint256 id = uint256(l.topics[1]);
        (, uint256 a0, uint256 a1) = abi.decode(l.data, (uint128, uint256, uint256));
        bool fresh;
        for (uint256 k; k < au.nNew; ++k) {
            if (au.newIds[k] == id) fresh = true;
        }
        if (!fresh) _violate(11, "the lane added liquidity to an existing position");
        au.inc0 += a0;
        au.inc1 += a1;
        if (!_open(pre)) {
            _violate(
                11,
                string.concat(
                    "liquidity added while closed: paused ",
                    vm.toString(pre.paused),
                    ", codes ",
                    vm.toString(uint256(pre.code0)),
                    "/",
                    vm.toString(uint256(pre.code1))
                )
            );
        }
    }

    /// @dev I10 (shape + placement fence at mint time, against the independent reference tick) and the per-mint part
    /// of I7 (the worst loss at the fence price stays within band x notional).
    struct Minted {
        uint8 slot;
        uint256 id;
        int24 tl;
        int24 tu;
        uint128 liq;
        uint256 a0;
        uint256 a1;
    }

    function _auditMint(Vm.Log memory l, Pre memory pre, Audit memory au) internal {
        Minted memory mt;
        (mt.slot, mt.id, mt.tl, mt.tu, mt.liq, mt.a0, mt.a1) =
            abi.decode(l.data, (uint8, uint256, int24, int24, uint128, uint256, uint256));
        (int24 ref, bool refOk) = LaneMath.refTick(pre.p0, pre.p1, dec0, dec1);
        int24 band = int24(uint24(pre.caps.placeBandBps));
        if (!refOk) _violate(10, "a position was minted without a fence reference");
        if (!_shapeOk(mt.tl, mt.tu, pre.caps)) {
            _violate(10, "a malformed range was minted");
        } else if (refOk && !_fenceHolds(mt.tl, mt.tu, pre.sqrtP, ref, band)) {
            _violate(10, _fenceMsg(mt, pre.tick, ref, band));
        }
        uint256 notional = LaneMath.usd6Up(mt.a0, pre.p0, dec0) + LaneMath.usd6Up(mt.a1, pre.p1, dec1);
        uint256 allowed = notional * LaneMath.tickFactorE18(band + 1) / 1e18 + 1;
        uint256 dev = _dev(mt.tl, mt.tu, mt.liq, pre.sqrtP, pre.p0, pre.p1);
        if (allowed > 100 && dev * 10_000 / allowed > maxMintDevBps) maxMintDevBps = dev * 10_000 / allowed;
        if (dev > allowed + 3) {
            _violate(
                7,
                string.concat(
                    "mint ",
                    vm.toString(mt.id),
                    " can lose ",
                    vm.toString(dev),
                    " usd6 > band x notional ",
                    vm.toString(allowed)
                )
            );
        }
        au.used0 += mt.a0;
        au.used1 += mt.a1;
        au.budget += allowed;
        au.slack += 6;
        mints++;
    }

    function _fenceMsg(Minted memory mt, int24 tick, int24 ref, int24 band) internal pure returns (string memory) {
        return string.concat(
            "range [",
            vm.toString(int256(mt.tl)),
            ",",
            vm.toString(int256(mt.tu)),
            ") minted outside the fence: tick ",
            vm.toString(int256(tick)),
            " ref ",
            vm.toString(int256(ref)),
            " band ",
            vm.toString(int256(band))
        );
    }

    function _auditLaneAction(Vm.Log memory l, Pre memory pre, address who) internal {
        uint8 a = uint8(uint256(l.topics[3]));
        (int24[] memory ticks, uint256 refPx,,,, address caller) =
            abi.decode(l.data, (int24[], uint256, uint8, uint16, bytes32, address));
        if (caller != who) _violate(8, "LaneAction.caller != msg.sender");
        bool isOwner = who == owner;
        bool isOp = who != address(0) && who == pre.op;
        bool isG = who != address(0) && who == pre.guard;
        bool allowed;
        if (
            a == uint8(IDeskTypes.Action.RERANGE) || a == uint8(IDeskTypes.Action.COLLECT)
                || a == uint8(IDeskTypes.Action.SIGNAL)
        ) {
            allowed = isOwner || isOp;
        } else if (
            a == uint8(IDeskTypes.Action.REDUCE) || a == uint8(IDeskTypes.Action.EXIT_ALL)
                || a == uint8(IDeskTypes.Action.PAUSE)
        ) {
            allowed = isOwner || isOp || isG;
        } else if (a == uint8(IDeskTypes.Action.SET_CLOSED_UNTIL)) {
            allowed = isOwner || isG;
        } else {
            allowed = isOwner;
        }
        if (!allowed) _violate(8, string.concat("LaneAction ", vm.toString(uint256(a)), " by ", _role(who, pre)));
        if (a == uint8(IDeskTypes.Action.RERANGE) && ticks.length != 0) {
            _lastTicks = ticks;
            if (refPx != Math.mulDiv(pre.p1, 1e18, pre.p0)) _violate(14, "LaneAction.refPxE18 != fence prices");
        }
    }

    function _auditNewPosition(uint256 id) internal {
        if (npm.ownerOf(id) != address(lane)) _violate(12, "a minted position is not owned by the lane");
        uint256[2] memory t = lane.positions();
        if (t[0] != id && t[1] != id) _violate(12, "a minted position is not tracked");
        (,, address a, address b, uint24 f,,,,,,,) = npm.positions(id);
        if (a != token0 || b != token1 || f != fee) _violate(6, "a lane position is not on the lane pool");
    }

    /// @dev Segments outside lane calls (attacker, owner deposits, market): nothing may leave the lane, lane positions
    /// may only receive liquidity, and every inflow is recorded (donations are not the lane's performance).
    function _auditExternal(Vm.Log[] memory logs) internal {
        (uint160 s,,,,,,) = pool.slot0();
        uint256 p0 = env.priceE18(0);
        uint256 p1 = env.priceE18(1);
        uint256[2] memory t = lane.positions();
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.topics.length == 0) continue;
            bytes32 t0 = l.topics[0];
            if (t0 == TRANSFER && l.topics.length >= 3) {
                address from = _addr(l.topics[1]);
                address to = _addr(l.topics[2]);
                if (from == address(lane)) _violate(1, "value left the lane outside a lane call");
                if (to != address(lane)) continue;
                if (l.topics.length == 3) {
                    epochIn += _usd(l.emitter, abi.decode(l.data, (uint256)), p0, p1);
                } else if (l.emitter == address(npm)) {
                    uint256 id = uint256(l.topics[3]);
                    if (!_isForeign[id]) {
                        _isForeign[id] = true;
                        _foreign.push(id);
                    }
                }
            } else if (t0 == APPROVAL && l.topics.length >= 3 && _addr(l.topics[1]) == address(lane)) {
                _violate(5, "a lane approval changed outside a lane call");
            } else if (l.emitter == address(npm) && l.topics.length >= 2) {
                uint256 id = uint256(l.topics[1]);
                if (id == 0 || (id != t[0] && id != t[1])) continue;
                if (t0 == NPM_DECREASE || t0 == NPM_COLLECT) _violate(1, "someone else touched a lane position");
                else if (t0 == NPM_INCREASE) _donatedLiquidity(id, l.data, s, p0, p1);
            }
        }
    }

    /// @dev Liquidity someone added to a lane position: an inflow, plus the exposure it brings at the fence price.
    function _donatedLiquidity(uint256 id, bytes memory data, uint160 s, uint256 p0, uint256 p1) internal {
        (uint128 liq, uint256 a0, uint256 a1) = abi.decode(data, (uint128, uint256, uint256));
        (,,,,, int24 tl, int24 tu,,,,,) = npm.positions(id);
        epochIn += LaneMath.usd6(a0, p0, dec0) + LaneMath.usd6(a1, p1, dec1);
        lossBudget += _dev(tl, tu, liq, s, p0, p1) + 3;
        slack += 3;
    }

    // ================================================================== internal: models

    function _trackDecision(bytes memory data, bool ok, Pre memory pre) internal {
        if (data.length < 68) return;
        bytes32 id;
        uint256 deadline;
        assembly ("memory-safe") {
            id := mload(add(data, 36))
            deadline := mload(add(data, 68))
        }
        if (!_known[id]) {
            _known[id] = true;
            _ids.push(id);
        }
        if (!ok) return;
        if (id == bytes32(0)) _violate(3, "a zero decisionId was accepted");
        if (expectUsedAt[id] != 0) _violate(3, "a decisionId was spent twice");
        expectUsedAt[id] = uint64(pre.ts);
        if (deadline < pre.ts || deadline > pre.ts + pre.caps.maxDeadlineAhead) {
            _violate(
                13, string.concat("a call with deadline ", vm.toString(deadline), " succeeded at ", vm.toString(pre.ts))
            );
        }
    }

    function _modelConfig(address who, bytes4 sel, bytes memory data, Pre memory pre) internal {
        if (sel == IDeskLane.pause.selector) {
            mPaused = true;
        } else if (sel == IDeskLane.unpause.selector) {
            mPaused = false;
        } else if (sel == IDeskLane.setClosedUntil.selector) {
            uint64 until = uint64(_arg(data, 0));
            if (who != owner && until < pre.closedUntil) _violate(8, "the guardian shortened closedUntil");
            mClosedUntil = until;
        } else if (sel == IDeskLane.proposeOperator.selector) {
            address op = address(uint160(_arg(data, 0)));
            if (op == address(0) || op == owner) _violate(8, "an invalid operator was proposed");
            mPendingOp = op;
            mPendingOpEta = uint64(pre.ts + 24 hours);
        } else if (sel == IDeskLane.applyOperator.selector) {
            if (mPendingOp == address(0) || pre.ts < mPendingOpEta) _violate(8, "an operator was applied early");
            mOperator = mPendingOp;
            mPendingOp = address(0);
            mPendingOpEta = 0;
        } else if (sel == IDeskLane.revokeOperator.selector) {
            mOperator = address(0);
            mPendingOp = address(0);
            mPendingOpEta = 0;
        } else if (sel == IDeskLane.setCaps.selector) {
            _modelSetCaps(abi.decode(_args(data), (IDeskTypes.Caps)), pre.ts);
        } else if (sel == IDeskLane.applyCaps.selector) {
            if (mPendingCapsEta == 0 || pre.ts < mPendingCapsEta) _violate(8, "caps were applied early");
            mCaps = mPendingCaps;
            delete mPendingCaps;
            mPendingCapsEta = 0;
        } else if (sel == IDeskLane.cancelCaps.selector) {
            if (mPendingCapsEta == 0) _violate(8, "cancelCaps succeeded with nothing pending");
            delete mPendingCaps;
            mPendingCapsEta = 0;
        } else if (sel == IDeskLane.setGuardian.selector) {
            mGuardian = address(uint160(_arg(data, 0)));
        }
    }

    /// @dev setCaps: tighter fields apply now, any looser field makes the WHOLE target pending for 24 h, and a
    /// tighten-only call drops a pending proposal. Written field by field, independently of CapsLib.
    function _modelSetCaps(IDeskTypes.Caps memory t, uint256 ts) internal {
        if (!_capsValid(t)) {
            _violate(8, "setCaps accepted caps outside the ceilings");
            return;
        }
        IDeskTypes.Caps memory c = mCaps;
        bool looser;
        if (t.maxDeployUsd6 > c.maxDeployUsd6) looser = true;
        else c.maxDeployUsd6 = t.maxDeployUsd6;
        if (t.turnoverUsd6PerDay > c.turnoverUsd6PerDay) looser = true;
        else c.turnoverUsd6PerDay = t.turnoverUsd6PerDay;
        if (t.placeBandBps > c.placeBandBps) looser = true;
        else c.placeBandBps = t.placeBandBps;
        if (t.maxTickDelta > c.maxTickDelta) looser = true;
        else c.maxTickDelta = t.maxTickDelta;
        if (t.minWidthTicks < c.minWidthTicks) looser = true;
        else c.minWidthTicks = t.minWidthTicks;
        if (t.maxWidthTicks > c.maxWidthTicks) looser = true;
        else c.maxWidthTicks = t.maxWidthTicks;
        if (t.reranges1h > c.reranges1h) looser = true;
        else c.reranges1h = t.reranges1h;
        if (t.reranges24h > c.reranges24h) looser = true;
        else c.reranges24h = t.reranges24h;
        if (t.minRerangeInterval < c.minRerangeInterval) looser = true;
        else c.minRerangeInterval = t.minRerangeInterval;
        if (t.maxDeadlineAhead > c.maxDeadlineAhead) looser = true;
        else c.maxDeadlineAhead = t.maxDeadlineAhead;
        if (t.maxRanges > c.maxRanges) looser = true;
        else c.maxRanges = t.maxRanges;
        mCaps = c;
        if (looser) {
            mPendingCaps = t;
            mPendingCapsEta = uint64(ts + 24 hours);
        } else if (mPendingCapsEta != 0) {
            delete mPendingCaps;
            mPendingCapsEta = 0;
        }
    }

    /// @dev I4 on every rerange: a success must fit the exact model (interval, both rerange buckets, deploy cap,
    /// turnover); a budget revert must be justified by it (within the lane's rounding). Also I11 and the LaneAction
    /// ticks.
    function _modelRerange(bytes memory data, bool ok, bytes memory ret, Pre memory pre, Audit memory au) internal {
        (bool known, int24[] memory ticks) = _rangeTicks(data);
        if (!known) return;
        uint256 n = ticks.length / 2;
        if (!ok) {
            _explainRerangeRevert(ret, pre, n);
            return;
        }
        if (pre.paused) _violate(11, "rerange succeeded while paused");
        if (n == 0) return; // unwind-and-hold: no fence, no budget
        riskReranges++;
        if (n > pre.caps.maxRanges) _violate(4, string.concat(vm.toString(n), " ranges minted above caps.maxRanges"));
        if (!_open(pre)) _violate(11, "a risk-adding rerange succeeded while closed");
        if (pre.ts < uint256(mLastRerange) + pre.caps.minRerangeInterval) {
            _violate(4, "rerange inside minRerangeInterval");
        }
        if (!_consume(mRr1h, pre.caps.reranges1h, 1 hours, 1, pre.ts)) _violate(4, "rerange with reranges1h empty");
        if (!_consume(mRr24h, pre.caps.reranges24h, 1 days, 1, pre.ts)) _violate(4, "rerange with reranges24h empty");
        if (au.notional > pre.caps.maxDeployUsd6) _violate(4, "deployed notional above maxDeployUsd6");
        if (!_consume(mTurn, pre.caps.turnoverUsd6PerDay, 1 days, au.notional, pre.ts)) {
            _violate(4, "the turnover bucket was overdrawn");
        }
        bucketWrites += 3;
        mLastRerange = uint64(pre.ts);
        turnoverUsed += au.notional;
        if (keccak256(abi.encode(_lastTicks)) != keccak256(abi.encode(ticks))) {
            _violate(8, "LaneAction ticks != ranges");
        }
    }

    function _explainRerangeRevert(bytes memory ret, Pre memory pre, uint256 n) internal {
        if (ret.length < 4 || n == 0) return;
        bytes4 e = bytes4(ret);
        if (e == IDeskLane.TooSoon.selector) {
            uint256 next = _word(ret, 0);
            if (next != uint256(mLastRerange) + pre.caps.minRerangeInterval || pre.ts >= next) {
                _violate(4, "TooSoon disagrees with the interval model");
            }
        } else if (e == IDeskLane.BucketEmpty.selector) {
            uint256 kind = _word(ret, 0);
            uint256 need = _word(ret, 1);
            uint256 lvl;
            uint256 period = kind == 1 ? 1 hours : 1 days;
            if (kind == 0) lvl = _level(mTurn, pre.caps.turnoverUsd6PerDay, period, pre.ts);
            else if (kind == 1) lvl = _level(mRr1h, pre.caps.reranges1h, period, pre.ts);
            else lvl = _level(mRr24h, pre.caps.reranges24h, period, pre.ts);
            if (lvl * WAD / period >= need * WAD + bucketWrites + 2) {
                _violate(4, string.concat("BucketEmpty(", vm.toString(kind), ") although the model covers the need"));
            }
        } else if (e == IDeskLane.DeployCapExceeded.selector) {
            if (_word(ret, 1) != pre.caps.maxDeployUsd6 || _word(ret, 0) <= _word(ret, 1)) {
                _violate(4, "DeployCapExceeded disagrees with the caps");
            }
        } else if (e == IDeskLane.MarketClosed.selector) {
            uint256 code = _word(ret, 0);
            uint8 want = pre.code0 != 0 ? pre.code0 : pre.code1;
            if (want != 0 ? code != want : code != 2) _violate(14, "MarketClosed code disagrees with the fence model");
        } else if (e == IDeskLane.ClosedUntilActive.selector) {
            if (pre.closedUntil <= pre.ts) _violate(11, "ClosedUntilActive after closedUntil passed");
        } else if (e == IDeskLane.IsPaused.selector) {
            if (!pre.paused) _violate(8, "IsPaused while the model is unpaused");
        }
    }

    function _consume(MBucket storage b, uint256 cap, uint256 period, uint256 amount, uint256 ts)
        internal
        returns (bool)
    {
        uint256 lvl = _level(b, cap, period, ts);
        if (amount * period > lvl) return false;
        b.num = lvl - amount * period;
        b.last = ts;
        return true;
    }

    function _level(MBucket storage b, uint256 cap, uint256 period, uint256 ts) internal view returns (uint256 lvl) {
        uint256 full = cap * period;
        lvl = b.num;
        if (ts > b.last) {
            uint256 dt = ts - b.last;
            lvl = dt >= period ? full : lvl + cap * dt;
        }
        if (lvl > full) lvl = full;
    }

    /// @dev The lane's floored budget view must lie in [floor(model - rounding), floor(model)].
    function _bucketMatches(uint256 got, MBucket storage b, uint256 cap, uint256 period) internal view returns (bool) {
        uint256 lvl = _level(b, cap, period, block.timestamp);
        uint256 hi = lvl / period;
        uint256 wad = lvl * WAD / period;
        uint256 err = bucketWrites + 2;
        uint256 lo = (wad > err ? wad - err : 0) / WAD;
        return got >= lo && got <= hi;
    }

    /// @dev The fence's code for token i as the model sees it (same priority order as IPriceFence documents).
    function _code(uint8 i) internal view returns (uint8) {
        DeskEnv.Feed memory f = env.feed(i);
        if (f.reverting) return 7;
        if (f.answer <= 0 || f.updatedAt > block.timestamp || block.timestamp - f.updatedAt > env.MAX_AGE()) return 2;
        uint256 px = uint256(f.answer) * 1e18 / 10 ** f.decimals;
        if (px == 0) return 2;
        if (i == stock) {
            if (env.oraclePaused()) return 3;
            uint256 at = env.effectiveAt();
            if (at != 0 && (block.timestamp > at ? block.timestamp - at : at - block.timestamp) < 2 hours) return 4;
            return LaneMath.stockWeekend(block.timestamp) ? 5 : 0;
        }
        return (px > 1e18 ? px - 1e18 : 1e18 - px) > 5e15 ? 6 : 0;
    }

    /// @dev The price the fence reports for token i (codes 0 and 3-6 carry a price), 0 otherwise.
    function _fencePx(uint8 i) internal view returns (uint256) {
        uint8 c = _code(i);
        if (c == 1 || c == 2 || c == 7) return 0;
        DeskEnv.Feed memory f = env.feed(i);
        return uint256(f.answer) * 1e18 / 10 ** f.decimals;
    }

    /// @dev The fence reference tick from the feeds alone.
    function _modelRef() internal view returns (int24, bool) {
        uint256 a = _fencePx(0);
        uint256 b = _fencePx(1);
        if (a == 0 || b == 0) return (0, false);
        return LaneMath.refTick(a, b, dec0, dec1);
    }

    function _fairTick() internal view returns (int24 t) {
        (t,) = LaneMath.refTick(env.priceE18(0), env.priceE18(1), dec0, dec1);
    }

    function _refOrFair() internal view returns (int24) {
        (int24 r, bool ok) = _modelRef();
        return ok ? r : _fairTick();
    }

    function _open(Pre memory p) internal pure returns (bool) {
        return !p.paused && p.closedUntil <= p.ts && p.code0 == 0 && p.code1 == 0;
    }

    function _openNow() internal view returns (bool) {
        return !mPaused && mClosedUntil <= block.timestamp && _code(0) == 0 && _code(1) == 0;
    }

    /// @dev Worst-case loss (usd6) of liquidity `liq` on [tl, tu) held at pool price `s`, valued at the fence prices:
    /// its value now minus its value with the pool at the fence price (where an arbitrageur leaves it).
    function _dev(int24 tl, int24 tu, uint128 liq, uint160 s, uint256 p0, uint256 p1) internal view returns (uint256) {
        uint256 sRef = LaneMath.sqrtPriceX96(p0, p1, dec0, dec1);
        if (sRef == 0) return 0;
        uint256 vNow = _valueAt(tl, tu, liq, s, p0, p1);
        uint256 vMin = _valueAt(tl, tu, liq, LaneMath.clampSqrt(sRef, tl, tu), p0, p1);
        return vNow > vMin ? vNow - vMin : 0;
    }

    function _valueAt(int24 tl, int24 tu, uint128 liq, uint160 s, uint256 p0, uint256 p1)
        internal
        view
        returns (uint256)
    {
        (uint256 a0, uint256 a1) = LaneMath.amounts(s, tl, tu, liq);
        return LaneMath.usd6(a0, p0, dec0) + LaneMath.usd6(a1, p1, dec1);
    }

    function _positionUsd(uint256 id, uint160 s, uint256 p0, uint256 p1) internal view returns (uint256) {
        (,,,,, int24 tl, int24 tu, uint128 liq,,, uint128 o0, uint128 o1) = npm.positions(id);
        (uint256 a0, uint256 a1) = LaneMath.amounts(s, tl, tu, liq);
        return LaneMath.usd6(a0 + o0, p0, dec0) + LaneMath.usd6(a1 + o1, p1, dec1);
    }

    function _usd(address token, uint256 amount, uint256 p0, uint256 p1) internal view returns (uint256) {
        if (token == token0) return LaneMath.usd6(amount, p0, dec0);
        if (token == token1) return LaneMath.usd6(amount, p1, dec1);
        return 0;
    }

    function _shapeOk(int24 tl, int24 tu, IDeskTypes.Caps memory c) internal view returns (bool) {
        if (tl >= tu || tl < TickMath.MIN_TICK || tu > TickMath.MAX_TICK) return false;
        if (tl % spacing != 0 || tu % spacing != 0) return false;
        uint256 w = uint256(int256(tu) - int256(tl));
        return w >= c.minWidthTicks && w <= c.maxWidthTicks;
    }

    /// @dev The placement fence from the position's EXACT holdings at the pool's sqrt price s (not from the rule's
    /// tick algebra, which it would only repeat): the range holds token0 iff s < sqrt(tu), offered from
    /// max(s, sqrt(tl)) up, never below ref - band; and token1 iff s > sqrt(tl), bid up to min(s, sqrt(tu)), never
    /// above ref + band + 1 (the current tick's bucket bids up to the pool price: the rule's one-tick slack).
    function _fenceHolds(int24 tl, int24 tu, uint160 s, int24 ref, int24 band) internal pure returns (bool) {
        uint160 sa = TickMath.getSqrtPriceAtTick(tl);
        uint160 sb = TickMath.getSqrtPriceAtTick(tu);
        if (s < sb && (s > sa ? s : sa) < _sqrtAt(int256(ref) - band)) return false;
        if (s > sa && (s < sb ? s : sb) > _sqrtAt(int256(ref) + band + 1)) return false;
        return true;
    }

    function _sqrtAt(int256 t) internal pure returns (uint160) {
        if (t < TickMath.MIN_TICK) t = TickMath.MIN_TICK;
        if (t > TickMath.MAX_TICK) t = TickMath.MAX_TICK;
        return TickMath.getSqrtPriceAtTick(int24(t));
    }

    function _capsValid(IDeskTypes.Caps memory c) internal view returns (bool) {
        IDeskTypes.Caps memory x = _ceil;
        return c.maxRanges <= 2 && c.minWidthTicks <= c.maxWidthTicks && c.maxDeployUsd6 <= x.maxDeployUsd6
            && c.turnoverUsd6PerDay <= x.turnoverUsd6PerDay && c.placeBandBps <= x.placeBandBps
            && c.maxTickDelta <= x.maxTickDelta && c.minWidthTicks >= x.minWidthTicks
            && c.maxWidthTicks <= x.maxWidthTicks && c.reranges1h <= x.reranges1h && c.reranges24h <= x.reranges24h
            && c.minRerangeInterval >= x.minRerangeInterval && c.maxDeadlineAhead <= x.maxDeadlineAhead
            && c.maxRanges <= x.maxRanges;
    }

    // ================================================================== internal: roles

    function _allowed(address who, bytes4 sel, Pre memory pre) internal view returns (bool) {
        bool isOwner = who == owner;
        bool isOp = who != address(0) && who == pre.op;
        bool isG = who != address(0) && who == pre.guard;
        if (sel == IDeskLane.rerange.selector || sel == IDeskLane.collect.selector || sel == IDeskLane.signal.selector)
        {
            return isOwner || isOp;
        }
        if (sel == IDeskLane.reduce.selector || sel == IDeskLane.exitAll.selector || sel == IDeskLane.pause.selector) {
            return isOwner || isOp || isG;
        }
        if (sel == IDeskLane.setClosedUntil.selector) return isOwner || isG;
        if (sel == IDeskLane.initialize.selector) return false;
        for (uint256 i = 6; i < 18; ++i) {
            if (sel == _sels[i]) return isOwner; // owner-only (see _initSelectors)
        }
        for (uint256 i = 19; i < 44; ++i) {
            if (sel == _sels[i]) return true; // views
        }
        return false;
    }

    function _role(address who, Pre memory pre) internal view returns (string memory) {
        if (who == owner) return "owner";
        if (who != address(0) && who == pre.op) return "operator";
        if (who != address(0) && who == pre.guard) return "guardian";
        if (who == attacker) return "attacker";
        return string.concat("stranger ", vm.toString(who));
    }

    function _takesMeta(bytes4 sel) internal pure returns (bool) {
        return sel == IDeskLane.rerange.selector || sel == IDeskLane.reduce.selector
            || sel == IDeskLane.collect.selector || sel == IDeskLane.exitAll.selector
            || sel == IDeskLane.signal.selector;
    }

    function _initSelectors() internal {
        bytes4[45] memory s = [
            IDeskLane.rerange.selector, // 0: operator | owner
            IDeskLane.reduce.selector,
            IDeskLane.collect.selector,
            IDeskLane.exitAll.selector,
            IDeskLane.signal.selector,
            IDeskLane.pause.selector, // 5
            IDeskLane.unpause.selector, // 6..17: owner only
            IDeskLane.withdraw.selector,
            IDeskLane.withdrawAll.selector,
            IDeskLane.withdrawPosition.selector,
            IDeskLane.proposeOperator.selector,
            IDeskLane.applyOperator.selector,
            IDeskLane.revokeOperator.selector,
            IDeskLane.setCaps.selector,
            IDeskLane.applyCaps.selector,
            IDeskLane.cancelCaps.selector,
            IDeskLane.setGuardian.selector,
            IDeskLane.setClosedUntil.selector, // 17 (owner | guardian)
            IDeskLane.initialize.selector, // 18: factory only
            IDeskLane.owner.selector, // 19..43: views
            IDeskLane.operator.selector,
            IDeskLane.guardian.selector,
            IDeskLane.laneId.selector,
            IDeskLane.pool.selector,
            IDeskLane.token0.selector,
            IDeskLane.token1.selector,
            IDeskLane.fence.selector,
            IDeskLane.paused.selector,
            IDeskLane.closedUntil.selector,
            IDeskLane.caps.selector,
            IDeskLane.pendingOperator.selector,
            IDeskLane.pendingCaps.selector,
            IDeskLane.decisionUsedAt.selector,
            IDeskLane.positions.selector,
            IDeskLane.budgets.selector,
            IDeskLane.riskAddingOpen.selector,
            IDeskLane.refTick.selector,
            bytes4(keccak256("poolParams()")),
            bytes4(keccak256("CEILINGS()")),
            bytes4(keccak256("lastRerangeAt()")),
            bytes4(keccak256("FACTORY()")),
            bytes4(keccak256("FENCE()")),
            bytes4(keccak256("NPM()")),
            bytes4(keccak256("V3_FACTORY()")), // 43
            bytes4(0xdeadbeef) // 44: unknown
        ];
        for (uint256 i; i < N_SELECTORS; ++i) {
            _sels.push(s[i]);
        }
    }

    function _selector(uint256 i) internal view returns (bytes4) {
        return _sels[i % N_SELECTORS];
    }

    /// @dev Selectors the guardian must never get through: every owner-only one plus rerange/collect/signal.
    function _forbiddenForGuardian(uint256 s) internal pure returns (uint256) {
        uint256[14] memory f = [uint256(0), 2, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        return f[s % 14];
    }

    // ================================================================== internal: random inputs

    /// @dev A type-correct random call to lane selector `which`.
    function _randomCall(uint256 which, uint256 seed) internal view returns (bytes memory) {
        uint256 i = which % N_SELECTORS;
        bytes4 sel = _sels[i];
        IDeskTypes.Caps memory c = mCaps;
        if (i == 0) {
            int24 t0 = _tick();
            IDeskTypes.RangeSpec[] memory r =
                _evilRanges(seed >> 64, t0, _refOrFair(), int24(uint24(c.placeBandBps)), c);
            return abi.encodeCall(IDeskLane.rerange, (_evilMeta(seed, c), r, t0, uint24((seed >> 32) % 70)));
        }
        if (i == 1) {
            return
                abi.encodeCall(
                    IDeskLane.reduce, (_evilMeta(seed, c), uint8((seed >> 8) % 4), _someLiquidity(seed >> 16))
                );
        }
        if (i >= 2 && i <= 4) return abi.encodePacked(sel, abi.encode(_evilMeta(seed, c)));
        if (i == 7) {
            // Scaled to what the lane holds, so an operator/attacker withdraw that auth let through would move tokens.
            address t = _pick3(seed, token0, token1, junk);
            return
                abi.encodeCall(IDeskLane.withdraw, (t, IERC20(t).balanceOf(address(lane)) * ((seed >> 8) % 101) / 100));
        }
        if (i == 9) return abi.encodeCall(IDeskLane.withdrawPosition, (uint8(seed % 4)));
        if (i == 10 || i == 16) return abi.encodePacked(sel, abi.encode(_randAddr(seed)));
        if (i == 13) return abi.encodeCall(IDeskLane.setCaps, (_randCaps(seed)));
        if (i == 17) return abi.encodeCall(IDeskLane.setClosedUntil, (uint64(seed % (block.timestamp + 5 days))));
        if (i == 18) {
            return abi.encodeCall(IDeskLane.initialize, (_randAddr(seed), _randAddr(seed >> 8), _randCaps(seed)));
        }
        if (i == 32) return abi.encodeCall(IDeskLane.decisionUsedAt, (bytes32(seed)));
        return abi.encodePacked(sel);
    }

    function _evilRanges(uint256 seed, int24 t0, int24 ref, int24 band, IDeskTypes.Caps memory c)
        internal
        view
        returns (IDeskTypes.RangeSpec[] memory r)
    {
        uint256 k = seed % 10;
        if (k < 3 && c.maxRanges == 1) {
            // One range more than the cap, and valid in every other respect: only caps.maxRanges can refuse it.
            r = _askAndBid(t0, ref, band, c, seed >> 8);
            if (r.length != 0) return r;
        }
        uint256 n = k == 0 ? uint256(c.maxRanges) + 1 : k < 4 ? 2 : 1;
        r = new IDeskTypes.RangeSpec[](n);
        for (uint256 i; i < n; ++i) {
            r[i] = _evilRange(uint256(keccak256(abi.encode(seed, i))), t0, ref, band, c);
            if (i != 0 && (seed >> 8) % 16 == 0) {
                (r[i].tickLower, r[i].tickUpper) = (r[i - 1].tickLower, r[i - 1].tickUpper); // duplicate
            }
        }
    }

    /// @dev The honest agent's single-sided pair, sized like an honest rerange: token0 from just above the pool (and
    /// no lower than ref - band), token1 up to the pool's aligned tick (and no higher than ref + band). Empty if no
    /// width or share fits the caps.
    function _askAndBid(int24 t0, int24 ref, int24 band, IDeskTypes.Caps memory c, uint256 seed)
        internal
        view
        returns (IDeskTypes.RangeSpec[] memory r)
    {
        int24 half = _halfWidth(c, seed);
        uint16 share = _share(c, seed >> 32);
        if (half == 0 || share == 0) return r;
        int24 tl = LaneMath.ceilTick(t0 + 1 > ref - band ? t0 + 1 : ref - band, spacing);
        int24 tu = LaneMath.floorTick(t0 < ref + band ? t0 : ref + band, spacing);
        r = new IDeskTypes.RangeSpec[](2);
        r[0] = IDeskTypes.RangeSpec(tl, tl + 2 * half, share, 0);
        r[1] = IDeskTypes.RangeSpec(tu - 2 * half, tu, 0, share);
    }

    /// @dev One crafted range: at or just beyond either fence edge, around the pool, anywhere, or inverted.
    function _evilRange(uint256 s, int24 t0, int24 ref, int24 band, IDeskTypes.Caps memory c)
        internal
        view
        returns (IDeskTypes.RangeSpec memory r)
    {
        int24 sp = spacing;
        int24 w = _evilWidth(s >> 200, c);
        uint256 kind = s % 20;
        kind = kind < 8 ? 0 : kind < 12 ? 1 : kind < 15 ? 2 : kind < 17 ? 3 : kind < 18 ? 4 : 5;
        if (kind == 0) {
            // token0 offered as cheaply as the fence allows (and a little beyond)
            r.tickLower = LaneMath.ceilTick(ref - band + int24(_randInt(s >> 8, -12, 12)), sp);
            r.tickUpper = r.tickLower + w;
        } else if (kind == 1) {
            // token1 bid as high as the fence allows (and a little beyond)
            r.tickUpper = LaneMath.floorTick(ref + band + int24(_randInt(s >> 8, -12, 12)), sp);
            r.tickLower = r.tickUpper - w;
        } else if (kind == 2) {
            r.tickLower = LaneMath.floorTick(t0 - int24(_randInt(s >> 8, 1, w)), sp);
            r.tickUpper = r.tickLower + w;
        } else if (kind == 3) {
            r.tickLower = ref + int24(_randInt(s >> 8, -3000, 3000));
            r.tickUpper = r.tickLower + int24(_randInt(s >> 24, -50, 3000));
        } else if (kind == 4) {
            // an inverted-orientation bug
            r.tickLower = LaneMath.floorTick(-ref - w / 2, sp);
            r.tickUpper = r.tickLower + w;
        } else {
            r.tickLower = LaneMath.floorTick(t0 - w / 2, sp);
            r.tickUpper = r.tickLower + w;
        }
        r.share0Bps = uint16((s >> 40) % 2 == 0 ? 10_000 : (s >> 48) % 10_001);
        r.share1Bps = uint16((s >> 64) % 2 == 0 ? 10_000 : (s >> 72) % 10_001);
    }

    function _evilWidth(uint256 s, IDeskTypes.Caps memory c) internal view returns (int24) {
        if (s % 10 == 0) return int24(_randInt(s >> 8, 1, 4000)); // anything, often malformed
        int256 lo = int256(uint256(c.minWidthTicks));
        int256 hi = int256(uint256(c.maxWidthTicks));
        if (hi > 2000) hi = 2000;
        if (lo > hi) return int24(lo);
        int256 w = _randInt(s >> 8, lo, hi);
        return int24(w - (w % spacing) + (w % spacing == 0 ? int256(0) : int256(spacing)));
    }

    function _evilMeta(uint256 seed, IDeskTypes.Caps memory c) internal view returns (IDeskTypes.Meta memory m) {
        uint256 k = seed % 10;
        uint256 now_ = block.timestamp;
        m.regime = uint8(seed >> 8);
        m.gatesMask = uint16(seed >> 16);
        m.reasonHash = keccak256(abi.encode(seed));
        m.decisionId = keccak256(abi.encode("evil", seed, _nonce, now_));
        m.deadline = uint64(now_ + (seed >> 32) % (uint256(c.maxDeadlineAhead) + 1));
        if (k == 0 && _ids.length != 0) m.decisionId = _ids[(seed >> 64) % _ids.length]; // replay
        else if (k == 1) m.decisionId = bytes32(0);
        else if (k == 2) m.deadline = uint64(now_ - 1);
        else if (k == 3) m.deadline = uint64(now_ + c.maxDeadlineAhead + 1);
        else if (k == 4) m.deadline = uint64(now_ + c.maxDeadlineAhead);
        else if (k == 5) m.deadline = uint64(now_);
        else if (k == 6) m.deadline = uint64(now_ + 1 days);
    }

    function _meta(uint64 deadline) internal returns (IDeskTypes.Meta memory) {
        return IDeskTypes.Meta({
            decisionId: keccak256(abi.encode("desk-invariant", ++_nonce)),
            deadline: deadline,
            regime: 1,
            gatesMask: 0,
            reasonHash: keccak256(abi.encode(_nonce))
        });
    }

    function _deadline(uint256 s) internal view returns (uint64) {
        return uint64(block.timestamp + s % (uint256(mCaps.maxDeadlineAhead) + 1));
    }

    function _randCaps(uint256 seed) internal view returns (IDeskTypes.Caps memory c) {
        IDeskTypes.Caps memory x = _ceil;
        c.maxDeployUsd6 = uint64(uint256(keccak256(abi.encode(seed, 0))) % (uint256(x.maxDeployUsd6) + 2));
        c.turnoverUsd6PerDay = uint64(uint256(keccak256(abi.encode(seed, 1))) % (uint256(x.turnoverUsd6PerDay) + 2));
        c.placeBandBps = uint16(uint256(keccak256(abi.encode(seed, 2))) % (uint256(x.placeBandBps) + 5));
        c.maxTickDelta = uint24(uint256(keccak256(abi.encode(seed, 3))) % (uint256(x.maxTickDelta) + 5));
        c.minWidthTicks = uint24(uint256(keccak256(abi.encode(seed, 4))) % 3000);
        c.maxWidthTicks = uint24(uint256(keccak256(abi.encode(seed, 5))) % (uint256(x.maxWidthTicks) + 5));
        c.reranges1h = uint16(uint256(keccak256(abi.encode(seed, 6))) % (uint256(x.reranges1h) + 2));
        c.reranges24h = uint16(uint256(keccak256(abi.encode(seed, 7))) % (uint256(x.reranges24h) + 2));
        c.minRerangeInterval = uint32(uint256(keccak256(abi.encode(seed, 8))) % 1000);
        c.maxDeadlineAhead = uint32(uint256(keccak256(abi.encode(seed, 9))) % (uint256(x.maxDeadlineAhead) + 5));
        c.maxRanges = uint8(uint256(keccak256(abi.encode(seed, 10))) % 4);
    }

    /// @dev Some fields strictly tighter, the rest unchanged (always within the ceilings).
    function _tighterCaps(uint256 seed) internal view returns (IDeskTypes.Caps memory c) {
        c = mCaps;
        uint256 f = seed % 12;
        uint256 s = seed >> 8;
        if (f == 0) c.maxDeployUsd6 = uint64(uint256(c.maxDeployUsd6) * (50 + s % 50) / 100);
        else if (f == 1) c.turnoverUsd6PerDay = uint64(uint256(c.turnoverUsd6PerDay) * (50 + s % 50) / 100);
        else if (f == 2 && c.placeBandBps > 20) c.placeBandBps -= uint16(1 + s % 20);
        else if (f == 3 && c.maxTickDelta > 2) c.maxTickDelta -= 1;
        else if (f == 4 && c.minWidthTicks + 20 <= c.maxWidthTicks) c.minWidthTicks += 10;
        else if (f == 5 && c.maxWidthTicks >= c.minWidthTicks + 100) c.maxWidthTicks -= 50;
        else if (f == 6 && c.reranges1h > 1) c.reranges1h -= 1;
        else if (f == 7 && c.reranges24h > 2) c.reranges24h -= 1;
        else if (f == 8) c.minRerangeInterval += uint32(30 + s % 300);
        else if (f == 9 && c.maxDeadlineAhead > 30) c.maxDeadlineAhead -= 10;
        else if (f >= 10 && c.maxRanges > 1) c.maxRanges = 1; // below MAX_SLOTS, where only the cap binds
    }

    /// @dev A proposal within the ceilings, usually looser than now (it goes pending for 24 h).
    function _looserCaps(uint256 seed) internal view returns (IDeskTypes.Caps memory c) {
        IDeskTypes.Caps memory x = _ceil;
        c = mCaps;
        c.maxDeployUsd6 = uint64(_between(seed, c.maxDeployUsd6, 200e6));
        c.turnoverUsd6PerDay = uint64(_between(seed >> 16, c.turnoverUsd6PerDay, 2_000e6));
        c.placeBandBps = uint16(_between(seed >> 32, c.placeBandBps, x.placeBandBps));
        c.maxTickDelta = uint24(_between(seed >> 48, c.maxTickDelta, x.maxTickDelta));
        c.minWidthTicks = uint24(x.minWidthTicks + (seed >> 64) % 40);
        c.maxWidthTicks = uint24(_between(seed >> 80, c.maxWidthTicks, 4000));
        c.reranges1h = uint16(_between(seed >> 96, c.reranges1h, x.reranges1h));
        c.reranges24h = uint16(_between(seed >> 112, c.reranges24h, x.reranges24h));
        c.minRerangeInterval = uint32(x.minRerangeInterval + (seed >> 128) % 300);
        c.maxDeadlineAhead = uint32(_between(seed >> 144, c.maxDeadlineAhead, x.maxDeadlineAhead));
        if ((seed >> 160) % 2 == 0) c.maxRanges = x.maxRanges; // else keep a tightened maxRanges in force
        if (c.minWidthTicks > c.maxWidthTicks) c.minWidthTicks = c.maxWidthTicks;
    }

    function _between(uint256 s, uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (hi <= lo) return hi;
        return lo + (s & 0xffff) % (hi - lo + 1);
    }

    /// @dev An aligned half-width whose straddle or single-sided ranges fit [minWidthTicks, maxWidthTicks].
    function _halfWidth(IDeskTypes.Caps memory c, uint256 seed) internal view returns (int24) {
        int256 sp = spacing;
        int256 lo = (int256(uint256(c.minWidthTicks)) + 1) / 2;
        lo = (lo + sp - 1) / sp * sp;
        if (lo < sp) lo = sp;
        int256 hi = (int256(uint256(c.maxWidthTicks)) - 2 * sp) / 2;
        if (hi > 600) hi = 600;
        hi = hi / sp * sp;
        if (hi < lo) return 0;
        return int24(lo + int256(seed % uint256((hi - lo) / sp + 1)) * sp);
    }

    /// @dev Share (bps) of the idle balances that keeps the notional under 90% of the deploy cap and turnover left.
    function _share(IDeskTypes.Caps memory c, uint256 seed) internal view returns (uint16) {
        uint256 v = nav();
        uint256 left = _level(mTurn, c.turnoverUsd6PerDay, 1 days, block.timestamp) / 1 days;
        uint256 lim = c.maxDeployUsd6 < left ? c.maxDeployUsd6 : left;
        if (v == 0 || lim == 0) return 0;
        uint256 s = lim * 9_000 / v;
        if (s > 10_000) s = 10_000;
        return uint16(s * (50 + seed % 51) / 100);
    }

    function _someLiquidity(uint256 s) internal view returns (uint128) {
        uint256 id = lane.positions()[s % 2];
        if (id == 0) return uint128(s >> 8);
        (,,,,,,, uint128 liq,,,,) = npm.positions(id);
        uint256 k = (s >> 8) % 4;
        return k == 0 ? type(uint128).max : k == 1 ? liq : uint128(uint256(liq) * (1 + (s >> 16) % 99) / 100);
    }

    function _someTracked(uint256 seed) internal view returns (uint256) {
        uint256[2] memory t = lane.positions();
        uint256 a = t[seed % 2];
        return a != 0 ? a : t[(seed + 1) % 2];
    }

    function _randAddr(uint256 s) internal view returns (address) {
        uint256 k = s % 8;
        if (k == 0) return owner;
        if (k == 1) return operator1;
        if (k == 2) return operator2;
        if (k == 3) return attacker;
        if (k == 4) return guardian2;
        if (k == 5) return address(0);
        return address(uint160(uint256(keccak256(abi.encode(s)))));
    }

    function _pick3(uint256 s, address a, address b, address c) internal pure returns (address) {
        uint256 k = s % 3;
        return k == 0 ? a : k == 1 ? b : c;
    }

    function _randInt(uint256 s, int256 lo, int256 hi) internal pure returns (int256) {
        if (hi <= lo) return lo;
        return lo + int256(s % uint256(hi - lo + 1));
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    // ================================================================== internal: exit drill (I2)

    function _exitDrill(bool broken) internal returns (string memory) {
        if (env.tokenPaused(0)) env.setTokenPaused(0, false);
        if (env.tokenPaused(1)) env.setTokenPaused(1, false);
        uint256[2] memory want = _laneHoldings();
        uint256[2] memory before = [IERC20(token0).balanceOf(owner), IERC20(token1).balanceOf(owner)];
        uint8 q = 1 - stock;
        if (broken) {
            env.setReverting(0, true);
            env.setReverting(1, true);
            env.setOraclePaused(true);
            vm.prank(owner);
            lane.setClosedUntil(type(uint64).max);
            vm.prank(owner);
            lane.pause();
            env.setTokenPaused(stock, true);
        }
        if (!_ownerCall(abi.encodeCall(IDeskLane.exitAll, (_meta(uint64(block.timestamp)))))) {
            return "exitAll reverted";
        }
        if (!_ownerCall(abi.encodeCall(IDeskLane.withdrawAll, ()))) return "withdrawAll reverted";
        uint256[2] memory kept = lane.positions();
        for (uint8 k; k < 2; ++k) {
            if (kept[k] == 0) continue;
            if (!_ownerCall(abi.encodeCall(IDeskLane.withdrawPosition, (k)))) return "withdrawPosition reverted";
        }
        uint256[2] memory after_ = lane.positions();
        if (after_[0] != 0 || after_[1] != 0) return "a slot is still tracked";
        if (broken) {
            if (IERC20(env.token(q)).balanceOf(address(lane)) != 0) return "the healthy token did not all come out";
            env.setTokenPaused(stock, false);
            if (!_ownerCall(abi.encodeCall(IDeskLane.withdrawAll, ()))) return "withdrawAll after unpause reverted";
        }
        if (IERC20(token0).balanceOf(address(lane)) != 0 || IERC20(token1).balanceOf(address(lane)) != 0) {
            return "tokens are left in the lane";
        }
        uint256[2] memory got =
            [IERC20(token0).balanceOf(owner) - before[0], IERC20(token1).balanceOf(owner) - before[1]];
        for (uint256 k; k < 2; ++k) {
            if (kept[k] == 0) continue;
            if (npm.ownerOf(kept[k]) != owner) return "a kept position did not reach the owner";
            (uint256 o0, uint256 o1) = _owed(kept[k]);
            got[0] += o0;
            got[1] += o1;
        }
        if (got[0] + 4 < want[0] || got[1] + 4 < want[1]) return "the owner recovered less than the lane held";
        return "";
    }

    /// @dev Token amounts the lane can exit to: idle balances plus every tracked position's principal and owed tokens.
    function _laneHoldings() internal view returns (uint256[2] memory want) {
        uint256[2] memory t = lane.positions();
        (uint160 s,,,,,,) = pool.slot0();
        want[0] = IERC20(token0).balanceOf(address(lane));
        want[1] = IERC20(token1).balanceOf(address(lane));
        for (uint256 k; k < 2; ++k) {
            if (t[k] == 0) continue;
            (,,,,, int24 tl, int24 tu, uint128 liq,,,,) = npm.positions(t[k]);
            (uint256 a0, uint256 a1) = LaneMath.amounts(s, tl, tu, liq);
            (uint256 o0, uint256 o1) = _owed(t[k]);
            want[0] += a0 + o0;
            want[1] += a1 + o1;
        }
    }

    function _owed(uint256 id) internal view returns (uint256, uint256) {
        (,,,,,,,,,, uint128 o0, uint128 o1) = npm.positions(id);
        return (o0, o1);
    }

    function _ownerCall(bytes memory data) internal returns (bool ok) {
        vm.prank(owner);
        (ok,) = address(lane).call(data);
    }

    // ================================================================== internal: bytes and stats

    function _violate(uint8 i, string memory why) internal {
        if (violations[i]++ == 0) _first[i] = why;
    }

    function _stat(bool ok, bytes memory ret) internal {
        if (ok) {
            actLaneOk[_act]++;
            return;
        }
        actLaneReverts[_act]++;
        bytes4 e = ret.length >= 4 ? bytes4(ret) : bytes4(0);
        if (revertsBy[e]++ == 0) _revertSels.push(e);
    }

    function _arr(uint256[41] storage a) internal view returns (string memory j) {
        j = "[";
        for (uint256 i; i < N_ACTIONS; ++i) {
            j = string.concat(j, i == 0 ? "" : ",", vm.toString(a[i]));
        }
        j = string.concat(j, "]");
    }

    function _bucketMsg(string memory name, uint256 got) internal view returns (string memory) {
        return string.concat(
            name, " budget ", vm.toString(got), " disagrees with the model (writes ", vm.toString(bucketWrites), ")"
        );
    }

    function _tick() internal view returns (int24 t) {
        (, t,,,,,) = pool.slot0();
    }

    function _ownerOrZero(uint256 id) internal view returns (address) {
        try npm.ownerOf(id) returns (address o) {
            return o;
        } catch {
            return address(0);
        }
    }

    function _addr(bytes32 w) internal pure returns (address) {
        return address(uint160(uint256(w)));
    }

    /// @dev Word `i` of ABI data after a 4-byte selector (0 if out of range).
    function _word(bytes memory b, uint256 i) internal pure returns (uint256 w) {
        if (b.length < 4 + 32 * (i + 1)) return 0;
        assembly ("memory-safe") {
            w := mload(add(add(b, 36), mul(i, 32)))
        }
    }

    function _arg(bytes memory data, uint256 i) internal pure returns (uint256) {
        return _word(data, i);
    }

    function _args(bytes memory data) internal pure returns (bytes memory out) {
        out = new bytes(data.length - 4);
        for (uint256 i; i < out.length; ++i) {
            out[i] = data[i + 4];
        }
    }

    /// @dev The ranges of rerange calldata as [tl0, tu0, tl1, tu1, ...], bounds-checked (`known` false if malformed).
    function _rangeTicks(bytes memory data) internal pure returns (bool known, int24[] memory ticks) {
        uint256 off = _word(data, 5); // Meta is 5 static words, then the offset of RangeSpec[]
        if (off > data.length || 4 + off + 32 > data.length) return (false, ticks);
        uint256 n;
        assembly ("memory-safe") {
            n := mload(add(add(data, 36), off))
        }
        if (n > 16 || 4 + off + 32 + n * 128 > data.length) return (false, ticks);
        ticks = new int24[](2 * n);
        for (uint256 i; i < n; ++i) {
            uint256 base = off + 32 + i * 128;
            int256 tl;
            int256 tu;
            assembly ("memory-safe") {
                tl := mload(add(add(data, 36), base))
                tu := mload(add(add(data, 36), add(base, 32)))
            }
            ticks[2 * i] = int24(tl);
            ticks[2 * i + 1] = int24(tu);
        }
        return (true, ticks);
    }
}
