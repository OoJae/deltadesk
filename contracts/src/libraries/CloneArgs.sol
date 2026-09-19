// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title The immutable args appended to every DeskLane clone (EIP-1167 with immutable args, OZ Clones).
/// @notice Layout, abi.encodePacked: owner (20) | laneId (1) | pool (20) | token0 (20) | token1 (20) | fee (3) |
/// tickSpacing (3) | dec0 (1) | dec1 (1)  = 89 bytes.
library CloneArgs {
    uint256 internal constant LENGTH = 89;

    struct Args {
        address owner;
        uint8 laneId;
        address pool;
        address token0;
        address token1;
        uint24 fee;
        int24 tickSpacing;
        uint8 dec0;
        uint8 dec1;
    }

    function encode(Args memory a) internal pure returns (bytes memory) {
        return abi.encodePacked(a.owner, a.laneId, a.pool, a.token0, a.token1, a.fee, a.tickSpacing, a.dec0, a.dec1);
    }

    /// @dev `b` must be exactly LENGTH bytes (checked by the caller).
    function decode(bytes memory b) internal pure returns (Args memory a) {
        address owner;
        uint8 laneId;
        address pool;
        address token0;
        address token1;
        uint24 fee;
        int24 tickSpacing;
        uint8 dec0;
        uint8 dec1;
        assembly ("memory-safe") {
            let p := add(b, 32)
            owner := shr(96, mload(p))
            laneId := byte(0, mload(add(p, 20)))
            pool := shr(96, mload(add(p, 21)))
            token0 := shr(96, mload(add(p, 41)))
            // The last word is read so that it ends exactly at byte 89 (no read past the array).
            let w := mload(add(p, 57))
            token1 := and(shr(64, w), 0xffffffffffffffffffffffffffffffffffffffff)
            fee := and(shr(40, w), 0xffffff)
            tickSpacing := signextend(2, and(shr(16, w), 0xffffff))
            dec0 := and(shr(8, w), 0xff)
            dec1 := and(w, 0xff)
        }
        a = Args(owner, laneId, pool, token0, token1, fee, tickSpacing, dec0, dec1);
    }
}
