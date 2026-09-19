// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MockToken} from "./MockToken.sol";

/// @notice A token that calls back into a target on every transfer (N11). The call is wrapped so the outer transfer
/// still succeeds; each attempt records whether the callback succeeded and its revert data (cleared on success), so a
/// test never reads a stale result from an earlier attempt.
contract HookToken is MockToken {
    address public target;
    bytes public payload;
    bool public armed;
    uint256 public attempts;
    bool public lastOk;
    bytes public lastRevert;

    constructor() MockToken("Hook", "HOOK", 18) {}

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed) {
            armed = false; // one shot, so the callback's own transfers do not recurse
            attempts++;
            (bool ok, bytes memory ret) = target.call(payload);
            lastOk = ok;
            lastRevert = ok ? bytes("") : ret;
        }
    }
}
