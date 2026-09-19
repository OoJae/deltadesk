// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {DeskLaneV3} from "../../src/DeskLaneV3.sol";
import {IDeskLane} from "../../src/interfaces/IDeskLane.sol";
import {IPriceFence} from "../../src/interfaces/IPriceFence.sol";
import {INonfungiblePositionManagerMin as INPM} from "../../src/interfaces/external/INonfungiblePositionManagerMin.sol";
import {IUniswapV3PoolMin} from "../../src/interfaces/external/IUniswapV3PoolMin.sol";
import {CloneArgs} from "../../src/libraries/CloneArgs.sol";
import {DeskHandler} from "./DeskHandler.sol";
import {DeskChecks} from "./DeskChecks.sol";
import {LocalHandlerSetup} from "./LocalHandlerSetup.sol";

/// @dev DeskLaneV3 plus a fallback that pays the caller: a stand-in for an implementation bug that leaks value.
contract LeakyLaneV3 is DeskLaneV3 {
    address internal immutable LEAK;

    constructor(address factory, address npm, address fence, address leak) DeskLaneV3(factory, npm, fence) {
        LEAK = leak;
    }

    fallback() external {
        IERC20(LEAK).transfer(msg.sender, 1e6);
    }
}

/// @dev DeskLaneV3 plus a fallback that reports a mint offering token0 150 ticks below the fence reference
/// (222267 at $222.60) with the pool parked below it: what an implementation that skipped the fence would do.
contract OffFenceLaneV3 is DeskLaneV3 {
    constructor(address factory, address npm, address fence) DeskLaneV3(factory, npm, fence) {}

    fallback() external {
        emit PositionMinted(bytes32(0), 0, 1, 222_010, 222_110, 1e12, 0, 0);
    }
}

/// @dev DeskLaneV3 plus a fallback that reports a mint of [tc, tc + 20) at the pool's current (aligned) tick tc. With
/// the pool parked at the top of tc far above the reference, that range bids token1 inside the current bucket at the
/// manipulated price: the placement the fence once let through (tl == tc skipped the bid check), and one a tick-rule
/// copy of the fence would also miss.
contract AtPoolTickLaneV3 is DeskLaneV3 {
    constructor(address factory, address npm, address fence) DeskLaneV3(factory, npm, fence) {}

    fallback() external {
        (, int24 t,,,,,) = IUniswapV3PoolMin(_args().pool).slot0();
        emit PositionMinted(bytes32(0), 0, 1, t, t + 20, 1e12, 0, 0);
    }
}

/// @dev The real lane code (delegated to) with one mutation: withdraw also lets the operator through, paying the
/// caller (PAY_CALLER) or the owner. A stand-in for a role bug in an owner-only exit that no transfer target check
/// alone would reveal when it pays the owner.
contract OperatorWithdrawLane {
    address internal immutable REAL;
    bool internal immutable PAY_CALLER;

    constructor(address real, bool payCaller) {
        REAL = real;
        PAY_CALLER = payCaller;
    }

    fallback() external {
        if (msg.sig == IDeskLane.withdraw.selector) {
            (address token, uint256 amount) = abi.decode(msg.data[4:], (address, uint256));
            address owner_ = CloneArgs.decode(Clones.fetchCloneArgs(address(this))).owner;
            address op;
            assembly ("memory-safe") {
                op := and(sload(0), 0xffffffffffffffffffffffffffffffffffffffff) // DeskLaneCore._operator
            }
            if (msg.sender != op && msg.sender != owner_) revert IDeskLane.NotOwner();
            IERC20(token).transfer(PAY_CALLER ? msg.sender : owner_, amount);
            return;
        }
        address real = REAL;
        assembly ("memory-safe") {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), real, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}

/// @notice Self-tests of the invariant harness: it drives every actor to real outcomes, and each check fires when the
/// property it guards is broken on purpose (state tampering, or an implementation etched with a bug). A check that can
/// never fail proves nothing; these show the campaign's zero findings are meaningful.
contract DeskChecksCanaryTest is LocalHandlerSetup, DeskChecks {
    DeskHandler internal h;

    function setUp() public override {
        super.setUp();
        h = _localHandler();
    }

    /// @dev A mixed random sequence reaches risk-adding reranges, evil placements, donations and foreign NFTs with
    /// every check green.
    function test_harnessDrivesEveryActor() public {
        for (uint256 i; i < 400; ++i) {
            _step(uint256(keccak256(abi.encode("coverage", i))));
            if (i % 25 == 0) _assertAllChecks(h);
        }
        _assertAllChecks(h);
        assertGt(h.riskReranges(), 0, "no risk-adding rerange landed");
        assertGt(h.mints(), 0, "nothing was minted");
        assertGt(h.actLaneOk(2), 0, "no evil rerange landed");
        assertGt(h.donations(), 0, "no donation");
        assertGt(h.priceSteps(), 0, "no fence price step");
        assertGt(h.idsLength(), 0, "no decisionIds tracked");
        for (uint256 v = 1; v < 15; ++v) {
            assertEq(h.violations(v), 0, h.firstViolation(v));
        }
        assertEq(bytes(h.ownerCanAlwaysExit()).length, 0, "I2");
    }

    function test_canary_I1_leakingImplementationIsCaught() public {
        LeakyLaneV3 leaky = new LeakyLaneV3(address(factory), address(npm), address(fence), address(usdg));
        vm.etch(address(impl), address(leaky).code);
        for (uint256 i; i < 600 && h.violations(1) == 0; ++i) {
            h.evilCall(i, i, "");
        }
        assertGt(h.violations(1), 0, "the auditor missed an ERC-20 leaving the lane");
        assertGt(h.violations(8), 0, "the role check missed an unknown selector succeeding");
    }

    /// @dev The evil operator's withdraw amounts are scaled to the lane's balances, so an operator-callable withdraw
    /// actually moves tokens and both I1 (value left to a non-owner exit) and I8 (role) fire, whichever way it pays.
    function test_canary_I1_I8_operatorWithdrawIsCaught() public {
        for (uint256 v; v < 2; ++v) {
            uint256 snap = vm.snapshotState();
            DeskLaneV3 real = new DeskLaneV3(address(factory), address(npm), address(fence));
            OperatorWithdrawLane bad = new OperatorWithdrawLane(address(real), v == 0);
            vm.etch(address(impl), address(bad).code);
            for (uint256 i; i < 600 && (h.violations(1) == 0 || h.violations(8) == 0); ++i) {
                h.evilCall(i, i, "");
            }
            assertGt(h.violations(1), 0, "the auditor missed an ERC-20 leaving through an operator withdraw");
            assertGt(h.violations(8), 0, "the role check missed an operator withdraw");
            vm.revertToState(snap);
        }
    }

    function test_canary_I10_offFenceMintIsCaught() public {
        OffFenceLaneV3 bad = new OffFenceLaneV3(address(factory), address(npm), address(fence));
        vm.etch(address(impl), address(bad).code);
        for (uint256 i; i < 600 && h.violations(10) == 0; ++i) {
            mover.moveTo(221_967); // 300 ticks under the reference: token0 above the pool is offered cheap
            h.evilCall(i, i, "");
        }
        assertGt(h.violations(10), 0, "the auditor missed an off-fence mint");
    }

    function test_canary_I10_bidAtParkedPoolTickIsCaught() public {
        AtPoolTickLaneV3 bad = new AtPoolTickLaneV3(address(factory), address(npm), address(fence));
        vm.etch(address(impl), address(bad).code);
        for (uint256 i; i < 600 && h.violations(10) == 0; ++i) {
            mover.moveTo(225_310);
            mover.moveTo(225_260); // the top of an aligned tick ~3,000 above the reference
            h.evilCall(i, i, "");
        }
        assertGt(h.violations(10), 0, "the auditor missed a bid inside the current bucket far above the band");
    }

    function test_canary_I3_decisionTampering() public {
        for (uint256 i; i < 50 && h.idsLength() == 0; ++i) {
            h.honestReduce(i);
        }
        bytes32 id = h.idAt(0);
        vm.store(address(lane), keccak256(abi.encode(id, uint256(15))), bytes32(uint256(h.expectUsedAt(id) + 1)));
        (bool ok,) = h.checkI3();
        assertFalse(ok);
    }

    function test_canary_I4_bucketTampering() public {
        // turnover bucket emptied now (Bucket packs levelWad in the low 192 bits and lastTs above it)
        vm.store(address(lane), bytes32(uint256(10)), bytes32(block.timestamp << 192));
        (bool ok,) = h.checkI4();
        assertFalse(ok);
    }

    function test_canary_I5_allowance() public {
        vm.prank(address(lane));
        usdg.approve(makeAddr("attacker"), 1);
        (bool ok,) = h.checkI5();
        assertFalse(ok);
    }

    function test_canary_I6_foreignPoolTracked() public {
        address decoy = h.decoyPool();
        (bool success, bytes memory ret) = decoy.staticcall(abi.encodeWithSignature("slot0()"));
        require(success);
        (, int24 t) = abi.decode(ret, (uint160, int24));
        usdg.mint(address(this), 10e6);
        nvda.mint(address(this), 1e18);
        usdg.approve(address(npm), type(uint256).max);
        nvda.approve(address(npm), type(uint256).max);
        (uint256 id,,,) = npm.mint(
            INPM.MintParams(
                address(usdg),
                address(nvda),
                3000,
                t / 60 * 60 - 600,
                t / 60 * 60 + 600,
                5e6,
                0.02e18,
                0,
                0,
                address(lane),
                block.timestamp
            )
        );
        vm.store(address(lane), bytes32(uint256(13)), bytes32(id));
        (bool ok,) = h.checkI6();
        assertFalse(ok);
    }

    function test_canary_I7_valueLeftTheLane() public {
        vm.prank(address(lane));
        usdg.transfer(makeAddr("thief"), 10e6);
        (bool ok,) = h.checkI7();
        assertFalse(ok);
    }

    function test_canary_I8_operatorSwapped() public {
        uint256 w = uint256(vm.load(address(lane), bytes32(0)));
        w = (w >> 160 << 160) | uint160(makeAddr("thief"));
        vm.store(address(lane), bytes32(0), bytes32(w));
        (bool ok,) = h.checkI8();
        assertFalse(ok);
    }

    function test_canary_I12_untrackedPosition() public {
        for (uint256 i; i < 200 && h.mints() == 0; ++i) {
            h.honestRerange(uint256(keccak256(abi.encode("mint", i))));
        }
        require(h.mints() > 0, "no mint to untrack");
        vm.store(address(lane), bytes32(uint256(13)), bytes32(0));
        vm.store(address(lane), bytes32(uint256(14)), bytes32(0));
        (bool ok,) = h.checkI12();
        assertFalse(ok);
    }

    function test_canary_I14_fenceDisagrees() public {
        (uint256 p,, uint8 code) = fence.usdPrice(address(nvda));
        vm.mockCall(
            address(fence),
            abi.encodeCall(IPriceFence.usdPrice, (address(nvda))),
            abi.encode(p * 101 / 100, uint64(block.timestamp), code)
        );
        (bool ok,) = h.checkI14();
        assertFalse(ok);
    }

    // ------------------------------------------------------------------ helpers

    function _step(uint256 seed) internal {
        uint256 f = seed % 11;
        uint256 s = seed >> 8;
        if (f == 0) h.honestRerange(s);
        else if (f == 1) h.honestReduce(s);
        else if (f == 2) h.evilRerange(s);
        else if (f == 3) h.evilCall(s, s >> 8, abi.encode(s));
        else if (f == 4) h.attackerAct(s, abi.encode(s >> 16));
        else if (f == 5) h.ownerAct(s);
        else if (f == 6) h.guardianAct(s);
        else if (f == 7) h.warp(s);
        else if (f == 8) h.movePrice(s);
        else if (f == 9) h.oracleAct(s);
        else h.tokenAct(s);
    }
}
