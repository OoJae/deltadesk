// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {TokenBucket} from "../../src/libraries/TokenBucket.sol";

contract BucketHarness {
    using TokenBucket for TokenBucket.Bucket;

    TokenBucket.Bucket public b;

    function fill(uint256 cap, uint256 nowTs) external {
        b.fill(cap, nowTs);
    }

    function consume(uint256 cap, uint256 period, uint256 amount, uint256 nowTs)
        external
        returns (bool ok, uint256 have)
    {
        return b.consume(cap, period, amount, nowTs);
    }

    function available(uint256 cap, uint256 period, uint256 nowTs) external view returns (uint256) {
        return TokenBucket.available(b, cap, period, nowTs);
    }

    function availableWad(uint256 cap, uint256 period, uint256 nowTs) external view returns (uint256) {
        return TokenBucket.availableWad(b, cap, period, nowTs);
    }
}

contract TokenBucketTest is Test {
    BucketHarness internal h;
    uint256 internal constant T0 = 1_789_570_800;

    function setUp() public {
        h = new BucketHarness();
        h.fill(4, T0);
    }

    function test_startsFullAndDrains() public {
        assertEq(h.available(4, 1 hours, T0), 4);
        for (uint256 i; i < 4; ++i) {
            (bool ok,) = h.consume(4, 1 hours, 1, T0);
            assertTrue(ok);
        }
        (bool ok2, uint256 have) = h.consume(4, 1 hours, 1, T0);
        assertFalse(ok2);
        assertEq(have, 0);
    }

    function test_linearRefill() public {
        h.consume(4, 1 hours, 4, T0);
        assertEq(h.available(4, 1 hours, T0 + 899), 0); // 3.99.. of 4 per hour -> 0.998 units
        assertEq(h.available(4, 1 hours, T0 + 900), 1);
        assertEq(h.available(4, 1 hours, T0 + 1800), 2);
        assertEq(h.availableWad(4, 1 hours, T0 + 1), uint256(4e18) / 3600);
        assertEq(h.available(4, 1 hours, T0 + 3600), 4);
        assertEq(h.available(4, 1 hours, T0 + 36_000), 4); // clamped at cap
    }

    function test_hugeDeltaT() public view {
        assertEq(h.available(4, 1 hours, type(uint64).max), 4);
        assertEq(h.available(type(uint64).max, 1 days, type(uint64).max), type(uint64).max);
    }

    function test_hugeCapNoOverflow() public {
        h.fill(type(uint64).max, T0);
        (bool ok,) = h.consume(type(uint64).max, 1 days, type(uint64).max, T0);
        assertTrue(ok);
        assertEq(
            h.available(type(uint64).max, 1 days, T0 + 1 days - 1), type(uint64).max - type(uint64).max / 86_400 - 1
        );
        assertEq(h.available(type(uint64).max, 1 days, T0 + 1 days), type(uint64).max);
    }

    /// @dev WAD accounting keeps fractional refill across updates: consuming one unit every 900 s from a 4 / h bucket
    /// is sustainable forever (a unit-floored bucket that reset its clock would starve).
    function test_noFractionalLossAtSteadyRate() public {
        h.consume(4, 1 hours, 4, T0); // empty
        uint256 t = T0;
        for (uint256 i; i < 200; ++i) {
            t += 900;
            (bool ok,) = h.consume(4, 1 hours, 1, t);
            assertTrue(ok);
        }
        // One second short of the rate eventually fails.
        h.fill(4, t);
        h.consume(4, 1 hours, 4, t);
        bool failed;
        for (uint256 i; i < 10 && !failed; ++i) {
            t += 899;
            (bool ok,) = h.consume(4, 1 hours, 1, t);
            failed = !ok;
        }
        assertTrue(failed);
    }

    /// @dev Rounding is always against the spender: available (floored) never exceeds the exact refill.
    function testFuzz_roundingAgainstSpender(uint64 cap, uint32 dt, uint64 used) public {
        cap = uint64(bound(cap, 1, type(uint64).max));
        used = uint64(bound(used, 0, cap));
        h.fill(cap, T0);
        h.consume(cap, 1 days, used, T0);
        uint256 exactWad = uint256(cap - used) * 1e18 + uint256(cap) * 1e18 * uint256(dt) / 1 days;
        uint256 got = h.availableWad(cap, 1 days, T0 + dt);
        uint256 capWad = uint256(cap) * 1e18;
        assertEq(got, exactWad < capWad ? exactWad : capWad);
        assertLe(h.available(cap, 1 days, T0 + dt) * 1e18, got);
    }

    function testFuzz_failureChangesNothing(uint64 cap, uint64 amount, uint32 dt) public {
        cap = uint64(bound(cap, 0, 1e15));
        h.fill(cap, T0);
        (uint192 lvl0, uint64 ts0) = h.b();
        uint256 avail = h.available(cap, 1 days, T0 + dt);
        amount = uint64(bound(amount, avail + 1, type(uint64).max));
        (bool ok, uint256 have) = h.consume(cap, 1 days, amount, T0 + dt);
        assertFalse(ok);
        assertEq(have, avail);
        (uint192 lvl1, uint64 ts1) = h.b();
        assertEq(lvl1, lvl0);
        assertEq(ts1, ts0);
    }

    /// @dev A tightened cap clamps the level on the next read.
    function test_capTightenClamps() public view {
        assertEq(h.available(2, 1 hours, T0), 2);
        assertEq(h.available(0, 1 hours, T0 + 1 days), 0);
    }
}
