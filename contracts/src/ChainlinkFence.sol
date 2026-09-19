// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPriceFence} from "./interfaces/IPriceFence.sol";
import {AggregatorV3Interface} from "./interfaces/external/AggregatorV3Interface.sol";
import {IERC8056} from "./interfaces/external/IERC8056.sol";

/// @title Coarse Chainlink price fence for Robinhood Chain (implements IPriceFence).
/// @notice The token -> feed table is fixed at construction; there is no admin (a new table means a new fence).
/// Every external read is a low-level staticcall with a return-length check, so a reverting, missing or malformed
/// feed/token yields a status code instead of a revert: status() and usdPrice() never revert.
/// Codes, in priority order (the first failure is returned):
///   1 UNKNOWN_TOKEN; 2 FEED_DEAD / 7 FEED_REVERTED (feed checks);
///   STOCK only: 3 ORACLE_PAUSED, 4 CORP_ACTION_WINDOW, 5 MARKET_CLOSED;  STABLE only: 6 DEPEG.
/// The ERC-8056 reads fail closed: a STOCK token that does not answer oraclePaused() reads as 3, and one that does not
/// answer effectiveAt() reads as 4.
contract ChainlinkFence is IPriceFence {
    enum Kind {
        NONE,
        STOCK,
        STABLE
    }

    struct TokenConfig {
        address token;
        address feed;
        Kind kind;
        uint32 maxAge; // seconds
    }

    uint8 public constant OK = 0;
    uint8 public constant UNKNOWN_TOKEN = 1;
    uint8 public constant FEED_DEAD = 2;
    uint8 public constant ORACLE_PAUSED = 3;
    uint8 public constant CORP_ACTION_WINDOW = 4;
    uint8 public constant MARKET_CLOSED = 5;
    uint8 public constant DEPEG = 6;
    uint8 public constant FEED_REVERTED = 7;

    /// @notice Risk-adding is blocked while |now - effectiveAt| < this.
    uint256 public constant CORP_ACTION_GUARD = 2 hours;
    /// @notice A STABLE token is depegged when |price - 1| > 50 bp.
    uint256 public constant DEPEG_TOLERANCE_E18 = 5e15;
    /// @notice Feeds reporting more decimals than this are treated as dead.
    uint256 public constant MAX_FEED_DECIMALS = 36;

    mapping(address token => TokenConfig) private _config; // written only in the constructor
    address[] private _tokens;

    error BadConfig(uint256 index);

    constructor(TokenConfig[] memory configs) {
        for (uint256 i; i < configs.length; ++i) {
            TokenConfig memory c = configs[i];
            if (c.token == address(0) || c.feed == address(0) || c.kind == Kind.NONE || c.maxAge == 0) {
                revert BadConfig(i);
            }
            if (_config[c.token].kind != Kind.NONE) revert BadConfig(i); // duplicate token
            _config[c.token] = c;
            _tokens.push(c.token);
        }
    }

    // ------------------------------------------------------------------ IPriceFence

    /// @inheritdoc IPriceFence
    function status(address token) external view returns (uint8 code) {
        (,, code) = _evaluate(token);
    }

    /// @inheritdoc IPriceFence
    /// @dev Returns (0, 0, code) for codes 1, 2 and 7. For codes 3-6 the feed itself is sound, so the price is returned
    /// alongside the code (useful for valuation); callers still must not add risk unless code == 0.
    function usdPrice(address token) external view returns (uint256 priceE18, uint64 updatedAt, uint8 code) {
        return _evaluate(token);
    }

    // ------------------------------------------------------------------ views

    function config(address token) external view returns (TokenConfig memory) {
        return _config[token];
    }

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    /// @notice The conservative stock weekend window in UTC: Sat 00:00 -> Mon 01:00. It covers the 24/5 feed pause
    /// (Fri 20:00 -> Sun 20:00 ET) under both US DST states with a margin. Unix day 0 (1970-01-01) was a Thursday, so
    /// dow = (day + 4) % 7 with 0 = Sunday.
    function isClosedWindow(uint256 ts) public pure returns (bool) {
        uint256 dow = (ts / 1 days + 4) % 7;
        return dow == 6 || dow == 0 || (dow == 1 && ts % 1 days < 1 hours);
    }

    // ------------------------------------------------------------------ internal

    function _evaluate(address token) internal view returns (uint256 priceE18, uint64 updatedAt, uint8 code) {
        TokenConfig memory c = _config[token];
        if (c.kind == Kind.NONE) return (0, 0, UNKNOWN_TOKEN);
        (priceE18, updatedAt, code) = _readFeed(c.feed, c.maxAge);
        if (code != OK) return (0, 0, code);
        if (c.kind == Kind.STOCK) {
            code = _stockStatus(token);
        } else {
            uint256 dev = priceE18 > 1e18 ? priceE18 - 1e18 : 1e18 - priceE18;
            if (dev > DEPEG_TOLERANCE_E18) code = DEPEG;
        }
    }

    function _readFeed(address feed, uint256 maxAge) internal view returns (uint256 priceE18, uint64, uint8) {
        (bool ok, bytes memory ret) = feed.staticcall(abi.encodeCall(AggregatorV3Interface.latestRoundData, ()));
        if (!ok || ret.length < 160) return (0, 0, FEED_REVERTED);
        // Decoded as full words so that out-of-range uint80 fields cannot make the decoder revert.
        (, int256 answer,, uint256 updatedAt,) = abi.decode(ret, (uint256, int256, uint256, uint256, uint256));
        if (answer <= 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > maxAge) {
            return (0, 0, FEED_DEAD);
        }
        // Proxy decimals changed from 18 to 8 on 2026-06-23: always read them live.
        (ok, ret) = feed.staticcall(abi.encodeCall(AggregatorV3Interface.decimals, ()));
        if (!ok || ret.length < 32) return (0, 0, FEED_REVERTED);
        uint256 dec = abi.decode(ret, (uint256));
        if (dec > MAX_FEED_DECIMALS || uint256(answer) > type(uint128).max) return (0, 0, FEED_DEAD);
        priceE18 = uint256(answer) * 1e18 / 10 ** dec;
        if (priceE18 == 0) return (0, 0, FEED_DEAD);
        return (priceE18, uint64(updatedAt), OK);
    }

    function _stockStatus(address token) internal view returns (uint8) {
        (bool ok, uint256 v) = _readWord(token, IERC8056.oraclePaused.selector);
        if (!ok || v != 0) return ORACLE_PAUSED;
        (ok, v) = _readWord(token, IERC8056.effectiveAt.selector);
        if (!ok) return CORP_ACTION_WINDOW;
        if (v != 0) {
            uint256 dist = block.timestamp > v ? block.timestamp - v : v - block.timestamp;
            if (dist < CORP_ACTION_GUARD) return CORP_ACTION_WINDOW;
        }
        if (isClosedWindow(block.timestamp)) return MARKET_CLOSED;
        return OK;
    }

    function _readWord(address target, bytes4 selector) internal view returns (bool ok, uint256 v) {
        bytes memory ret;
        (ok, ret) = target.staticcall(abi.encodeWithSelector(selector));
        if (!ok || ret.length < 32) return (false, 0);
        v = abi.decode(ret, (uint256));
    }
}
