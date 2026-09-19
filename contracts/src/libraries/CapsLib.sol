// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDeskTypes} from "../interfaces/IDeskTypes.sol";

/// @title Direction-aware comparisons of IDeskTypes.Caps.
/// @notice "Tighter" per IDeskTypes: smaller for every max/limit/count/band/width-max field and for
/// maxDeadlineAhead; LARGER for minWidthTicks and minRerangeInterval. A ceiling is therefore an upper bound on the
/// first kind and a lower bound on minWidthTicks and minRerangeInterval.
/// Field indexes (used by CapsAboveCeiling) follow the struct order: 0 maxDeployUsd6, 1 turnoverUsd6PerDay,
/// 2 placeBandBps, 3 maxTickDelta, 4 minWidthTicks, 5 maxWidthTicks, 6 reranges1h, 7 reranges24h,
/// 8 minRerangeInterval, 9 maxDeadlineAhead, 10 maxRanges.
/// @dev A `Caps memory` value is laid out as 11 consecutive 32-byte words (one cleaned value per field, in declaration
/// order), so the fields are walked by index instead of being spelled out.
library CapsLib {
    uint8 internal constant NONE = type(uint8).max;
    uint256 internal constant FIELDS = 11;
    /// @dev Bit i set: field i is a lower-bound ("min") field, where larger is tighter.
    uint256 internal constant MIN_FIELDS = (1 << 4) | (1 << 8);

    /// @notice The first field of `c` that is looser than `ceil`, or NONE.
    function firstAboveCeiling(IDeskTypes.Caps memory c, IDeskTypes.Caps memory ceil) internal pure returns (uint8) {
        for (uint256 i; i < FIELDS; ++i) {
            if (_looser(field(c, i), field(ceil, i), i)) return uint8(i);
        }
        return NONE;
    }

    /// @notice Field-wise tighter of `cur` and `target`; `looser` is true when any field of `target` loosens `cur`.
    function tighterOf(IDeskTypes.Caps memory cur, IDeskTypes.Caps memory target)
        internal
        pure
        returns (IDeskTypes.Caps memory m, bool looser)
    {
        for (uint256 i; i < FIELDS; ++i) {
            uint256 t = field(target, i);
            uint256 c = field(cur, i);
            if (_looser(t, c, i)) {
                looser = true;
                t = c;
            }
            assembly ("memory-safe") {
                mstore(add(m, mul(i, 32)), t)
            }
        }
    }

    function eq(IDeskTypes.Caps memory a, IDeskTypes.Caps memory b) internal pure returns (bool r) {
        assembly ("memory-safe") {
            r := eq(keccak256(a, 352), keccak256(b, 352))
        }
    }

    /// @notice Field `i` of `c` (struct order), as a word.
    function field(IDeskTypes.Caps memory c, uint256 i) internal pure returns (uint256 v) {
        assembly ("memory-safe") {
            v := mload(add(c, mul(i, 32)))
        }
    }

    /// @notice Packs `c` into three words, four 64-bit lanes each (every Caps field fits in 64 bits):
    /// field i sits in word i / 4 at bit offset (i % 4) * 64.
    function pack(IDeskTypes.Caps memory c) internal pure returns (uint256[3] memory w) {
        for (uint256 i; i < FIELDS; ++i) {
            w[i / 4] |= field(c, i) << ((i % 4) * 64);
        }
    }

    /// @notice Inverse of pack. Words produced by pack always unpack to in-range field values.
    function unpack(uint256[3] memory w) internal pure returns (IDeskTypes.Caps memory c) {
        for (uint256 i; i < FIELDS; ++i) {
            uint256 v = packedField(w[i / 4], i);
            assembly ("memory-safe") {
                mstore(add(c, mul(i, 32)), v)
            }
        }
    }

    /// @notice Field `i` from the pack() word that holds it (w = words[i / 4]).
    function packedField(uint256 w, uint256 i) internal pure returns (uint256) {
        return (w >> ((i % 4) * 64)) & type(uint64).max;
    }

    function _looser(uint256 x, uint256 bound, uint256 i) private pure returns (bool) {
        return (MIN_FIELDS >> i) & 1 == 1 ? x < bound : x > bound;
    }
}
