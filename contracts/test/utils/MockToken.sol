// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test ERC-20 with configurable decimals, open minting, a global pause and a per-address blocklist.
/// While paused (or when either side is blocklisted) every transfer, mint and burn reverts, like the issuer controls
/// of Robinhood Chain stock tokens and USDG.
contract MockToken is ERC20 {
    uint8 private immutable _decimals;
    bool public paused;
    mapping(address => bool) public blocked;

    error TokenPaused();
    error AddressBlocked(address account);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setBlocked(address account, bool b) external {
        blocked[account] = b;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (paused) revert TokenPaused();
        if (blocked[from]) revert AddressBlocked(from);
        if (blocked[to]) revert AddressBlocked(to);
        super._update(from, to, value);
    }
}

/// @notice MockToken with the ERC-8056 surface of Robinhood Chain stock tokens (see IERC8056).
contract MockStockToken is MockToken {
    bool private _oraclePaused;
    uint256 private _uiMultiplier = 1e18;
    uint256 private _newUIMultiplier = 1e18;
    uint256 private _effectiveAt;
    /// @dev When set, every ERC-8056 getter reverts (a token without the extension).
    bool public erc8056Reverts;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) MockToken(name_, symbol_, decimals_) {}

    function oraclePaused() external view returns (bool) {
        _check();
        return _oraclePaused;
    }

    function uiMultiplier() external view returns (uint256) {
        _check();
        return block.timestamp >= _effectiveAt ? _newUIMultiplier : _uiMultiplier;
    }

    function newUIMultiplier() external view returns (uint256) {
        _check();
        return _newUIMultiplier;
    }

    function effectiveAt() external view returns (uint256) {
        _check();
        return _effectiveAt;
    }

    function setOraclePaused(bool p) external {
        _oraclePaused = p;
    }

    /// @notice Schedule a multiplier change (the current multiplier is kept until `at`).
    function setNewUIMultiplier(uint256 multiplier, uint256 at) external {
        _uiMultiplier = block.timestamp >= _effectiveAt ? _newUIMultiplier : _uiMultiplier;
        _newUIMultiplier = multiplier;
        _effectiveAt = at;
    }

    function setErc8056Reverts(bool r) external {
        erc8056Reverts = r;
    }

    function _check() private view {
        if (erc8056Reverts) revert("no ERC-8056");
    }
}
