// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AggregatorV3Interface} from "../../src/interfaces/external/AggregatorV3Interface.sol";
import {IERC8056} from "../../src/interfaces/external/IERC8056.sol";
import {MockAggregator} from "../utils/MockAggregator.sol";
import {MockStockToken, MockToken} from "../utils/MockToken.sol";

/// @notice The oracle, issuer and funding controls the invariant handler drives, behind one surface so the same handler
/// runs on the local fixture (mock feeds and tokens) and on a 4663 fork (real tokens and feeds under vm.mockCall).
/// The env state here is the source of truth; every change is pushed to the chain. Token i is the pool's token i;
/// `stockIndex` is the ERC-8056 stock token (STOCK fence kind), the other one is the STABLE quote.
abstract contract DeskEnv is Test {
    struct Feed {
        uint256 price8; // the reference USD price of one whole token, 8 decimals (the handler's fair value)
        int256 answer; // what latestRoundData() returns: price8 rescaled to `decimals`, or a broken value
        uint256 updatedAt;
        uint8 decimals;
        bool reverting;
        uint80 roundId;
    }

    uint256 public constant MAX_AGE = 26 hours; // the M2 fence maxAge of both feeds

    address[2] internal _tokens;
    Feed[2] internal _feeds;
    bool[2] internal _paused;
    uint8 public immutable stockIndex;

    bool public oraclePaused;
    uint256 public effectiveAt;
    uint256 public oldMultiplier = 1e18; // uiMultiplier before effectiveAt
    uint256 public newMultiplier = 1e18; // from effectiveAt on

    constructor(address t0, address t1, uint8 stockIndex_) {
        _tokens = [t0, t1];
        stockIndex = stockIndex_;
    }

    // ------------------------------------------------------------------ views

    function token(uint8 i) external view returns (address) {
        return _tokens[i];
    }

    function feed(uint8 i) external view returns (Feed memory) {
        return _feeds[i];
    }

    function tokenPaused(uint8 i) external view returns (bool) {
        return _paused[i];
    }

    /// @notice The fair USD price of one whole token i (1e18). Equals the fence price whenever the feed is healthy.
    function priceE18(uint8 i) external view returns (uint256) {
        return _feeds[i].price8 * 1e10;
    }

    /// @notice Whether feed i currently reports its fair price (no revert, no broken answer; age is not checked).
    function feedSound(uint8 i) public view returns (bool) {
        Feed storage f = _feeds[i];
        return !f.reverting && f.answer == _scaled(f.price8, f.decimals);
    }

    function uiMultiplier() public view returns (uint256) {
        return block.timestamp >= effectiveAt ? newMultiplier : oldMultiplier;
    }

    // ------------------------------------------------------------------ oracle controls

    /// @notice A new round at `price8` now (keeps the decimals).
    function setPrice8(uint8 i, uint256 price8) external {
        Feed storage f = _feeds[i];
        f.price8 = price8;
        f.answer = _scaled(price8, f.decimals);
        f.updatedAt = block.timestamp;
        f.roundId++;
        _push();
    }

    function setUpdatedAt(uint8 i, uint256 ts) external {
        _feeds[i].updatedAt = ts;
        _push();
    }

    /// @notice Switch the feed decimals (8 or 18), rescaling a sound answer so the price is unchanged (the Jun 23
    /// change of the 4663 proxies from 18 to 8 decimals).
    function setDecimals(uint8 i, uint8 dec) external {
        Feed storage f = _feeds[i];
        bool sound = f.answer == _scaled(f.price8, f.decimals);
        f.decimals = dec;
        if (sound) f.answer = _scaled(f.price8, dec);
        _push();
    }

    function setReverting(uint8 i, bool r) external {
        _feeds[i].reverting = r;
        _push();
    }

    /// @notice A broken round: a raw answer (0, negative, ...) and updatedAt (possibly in the future).
    function setRaw(uint8 i, int256 answer, uint256 updatedAt) external {
        Feed storage f = _feeds[i];
        f.answer = answer;
        f.updatedAt = updatedAt;
        f.roundId++;
        _push();
    }

    /// @notice Back to a healthy, fresh round at the fair price.
    function heal(uint8 i) external {
        Feed storage f = _feeds[i];
        f.answer = _scaled(f.price8, f.decimals);
        f.updatedAt = block.timestamp;
        f.reverting = false;
        f.roundId++;
        _push();
    }

    function setOraclePaused(bool p) external {
        oraclePaused = p;
        _push();
    }

    /// @notice Schedule a uiMultiplier change to `multiplier` at `at` (the current multiplier is kept until then).
    function setCorpAction(uint256 multiplier, uint256 at) external {
        oldMultiplier = uiMultiplier();
        newMultiplier = multiplier;
        effectiveAt = at;
        _push();
    }

    function setTokenPaused(uint8 i, bool p) external {
        _paused[i] = p;
        _push();
    }

    /// @notice Add `amount` of `tkn` to `to` (works while the token is paused).
    function fund(address tkn, address to, uint256 amount) external virtual;

    /// @notice Re-apply the env to the chain (a no-op unless it lives in cheatcode mocks).
    function sync() external virtual {}

    // ------------------------------------------------------------------ internal

    function _push() internal virtual;

    function _scaled(uint256 price8, uint8 dec) internal pure returns (int256) {
        return int256(dec >= 8 ? price8 * 10 ** (dec - 8) : price8 / 10 ** (8 - dec));
    }

    function _initFeed(uint8 i, int256 answer, uint256 updatedAt, uint8 dec, uint80 roundId) internal {
        uint256 a = answer > 0 ? uint256(answer) : 0;
        uint256 price8 = dec >= 8 ? a / 10 ** (dec - 8) : a * 10 ** (8 - dec);
        _feeds[i] = Feed(price8, _scaled(price8, dec), updatedAt, dec, false, roundId);
    }
}

/// @notice The local fixture: MockAggregator feeds, a MockToken quote and a MockStockToken (ERC-8056) stock token.
contract LocalDeskEnv is DeskEnv {
    MockAggregator[2] internal _aggs;

    constructor(MockToken t0, MockToken t1, MockAggregator f0, MockAggregator f1, uint8 stockIndex_)
        DeskEnv(address(t0), address(t1), stockIndex_)
    {
        _aggs = [f0, f1];
        for (uint8 i; i < 2; ++i) {
            MockAggregator a = _aggs[i];
            _initFeed(i, a.answer(), a.updatedAt(), a.decimals(), a.roundId());
        }
        _push();
    }

    function fund(address tkn, address to, uint256 amount) external override {
        MockToken t = MockToken(tkn);
        bool p = t.paused();
        if (p) t.setPaused(false);
        t.mint(to, amount);
        if (p) t.setPaused(true);
    }

    function _push() internal override {
        for (uint8 i; i < 2; ++i) {
            Feed storage f = _feeds[i];
            MockAggregator a = _aggs[i];
            a.set(f.answer, f.updatedAt);
            a.setDecimals(f.decimals);
            a.setReverting(f.reverting);
            MockToken(_tokens[i]).setPaused(_paused[i]);
        }
        MockStockToken s = MockStockToken(_tokens[stockIndex]);
        s.setOraclePaused(oraclePaused);
        if (s.effectiveAt() != effectiveAt || s.newUIMultiplier() != newMultiplier) {
            s.setNewUIMultiplier(newMultiplier, effectiveAt);
        }
    }
}

/// @notice A 4663 fork: the real tokens, pool and NPM, with the Chainlink proxies and the stock token's ERC-8056 getters
/// answered by vm.mockCall, and a token "pause" as a mocked revert of transfer/transferFrom. Funding writes the
/// balance slots directly (USDG: mapping at slot 1; NVDA: OpenZeppelin ERC-7201 ERC20Storage), falling back to deal.
contract ForkDeskEnv is DeskEnv {
    /// @dev keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ERC20")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant OZ_ERC20_STORAGE = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00;

    address[2] internal _feedAddrs;
    uint256[2] internal _balanceSlotBase; // mapping slot of each token's balances

    constructor(address t0, address t1, address f0, address f1, uint8 stockIndex_, uint256[2] memory balanceSlotBase)
        DeskEnv(t0, t1, stockIndex_)
    {
        _feedAddrs = [f0, f1];
        _balanceSlotBase = balanceSlotBase;
        for (uint8 i; i < 2; ++i) {
            AggregatorV3Interface a = AggregatorV3Interface(_feedAddrs[i]);
            (uint80 rid, int256 answer,, uint256 updatedAt,) = a.latestRoundData();
            _initFeed(i, answer, updatedAt, a.decimals(), rid);
        }
        IERC8056 s = IERC8056(_tokens[stockIndex_]);
        oraclePaused = s.oraclePaused();
        effectiveAt = s.effectiveAt();
        newMultiplier = s.newUIMultiplier();
        oldMultiplier = s.uiMultiplier();
        _push();
    }

    /// @notice The OZ ERC-7201 balances base, for tokens built on ERC20Upgradeable v5.
    function ozErc20Storage() external pure returns (uint256) {
        return uint256(OZ_ERC20_STORAGE);
    }

    function fund(address tkn, address to, uint256 amount) external override {
        uint256 want = IERC20(tkn).balanceOf(to) + amount;
        uint256 base =
            tkn == _tokens[0] ? _balanceSlotBase[0] : tkn == _tokens[1] ? _balanceSlotBase[1] : type(uint256).max;
        if (base != type(uint256).max) {
            vm.store(tkn, keccak256(abi.encode(to, base)), bytes32(want));
            if (IERC20(tkn).balanceOf(to) == want) return;
        }
        deal(tkn, to, want);
    }

    function sync() external override {
        _push();
    }

    function _push() internal override {
        vm.clearMockedCalls();
        for (uint8 i; i < 2; ++i) {
            Feed storage f = _feeds[i];
            address a = _feedAddrs[i];
            vm.mockCall(a, abi.encodeWithSelector(AggregatorV3Interface.decimals.selector), abi.encode(f.decimals));
            if (f.reverting) {
                vm.mockCallRevert(
                    a, abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector), bytes("feed down")
                );
            } else {
                vm.mockCall(
                    a,
                    abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector),
                    abi.encode(f.roundId, f.answer, f.updatedAt, f.updatedAt, f.roundId)
                );
            }
            if (_paused[i]) {
                vm.mockCallRevert(_tokens[i], abi.encodeWithSelector(IERC20.transfer.selector), bytes("paused"));
                vm.mockCallRevert(_tokens[i], abi.encodeWithSelector(IERC20.transferFrom.selector), bytes("paused"));
            }
        }
        address s = _tokens[stockIndex];
        vm.mockCall(s, abi.encodeWithSelector(IERC8056.oraclePaused.selector), abi.encode(oraclePaused));
        vm.mockCall(s, abi.encodeWithSelector(IERC8056.effectiveAt.selector), abi.encode(effectiveAt));
        vm.mockCall(s, abi.encodeWithSelector(IERC8056.newUIMultiplier.selector), abi.encode(newMultiplier));
        vm.mockCall(s, abi.encodeWithSelector(IERC8056.uiMultiplier.selector), abi.encode(uiMultiplier()));
    }
}
