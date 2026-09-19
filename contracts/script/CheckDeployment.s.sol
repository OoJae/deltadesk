// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {ChainlinkFence} from "../src/ChainlinkFence.sol";
import {DeskLaneFactory} from "../src/DeskLaneFactory.sol";
import {DeskLaneV3} from "../src/DeskLaneV3.sol";
import {IDeskLane} from "../src/interfaces/IDeskLane.sol";
import {IDeskTypes} from "../src/interfaces/IDeskTypes.sol";
import {IUniswapV3FactoryMin} from "../src/interfaces/external/IUniswapV3FactoryMin.sol";
import {IUniswapV3PoolMin} from "../src/interfaces/external/IUniswapV3PoolMin.sol";
import {Addresses4663} from "./Addresses4663.sol";
import {DeskDefaults} from "./DeskDefaults.sol";
import {DeploymentFile} from "./DeploymentFile.sol";

/// @notice Read-only: reads the deployment record back from the chain and asserts every link and setting.
/// Optional env LANE=<lane address> also checks one lane (isLane, its EIP-1167 code delegates to the recorded
/// implementation, pool args, roles, caps).
/// Usage: forge script script/CheckDeployment.s.sol --rpc-url <url>   (no --broadcast)
contract CheckDeployment is Script {
    function run() external {
        DeploymentFile.Record memory r = DeploymentFile.read();
        ChainlinkFence fence = ChainlinkFence(r.fence);
        DeskLaneFactory factory = DeskLaneFactory(r.factory);
        DeskLaneV3 impl = DeskLaneV3(r.implementation);
        require(r.fence.code.length != 0 && r.factory.code.length != 0, "no code at fence/factory");
        require(r.implementation.code.length != 0, "no code at implementation");

        // Factory
        require(factory.V3_FACTORY() == Addresses4663.V3_FACTORY, "factory: V3_FACTORY");
        require(factory.implementations(DeskDefaults.KIND_V3_LP) == r.implementation, "factory: implementation");
        require(factory.poolAllowed(Addresses4663.POOL_NVDA_USDG, DeskDefaults.KIND_V3_LP), "factory: pool not allowed");
        require(_eq(factory.ceilings(), DeskDefaults.ceilings()), "factory: ceilings");
        console.log("factory admin   ", factory.admin());
        console.log("pending admin   ", factory.pendingAdmin());
        (address nextImpl, uint64 nextEta) = factory.pendingImplementation(DeskDefaults.KIND_V3_LP);
        if (nextImpl != address(0)) {
            console.log("WARNING: kind 1 implementation replacement pending", nextImpl, "eta", nextEta);
        }

        // Implementation
        require(impl.FACTORY() == r.factory, "impl: FACTORY");
        require(address(impl.NPM()) == Addresses4663.NPM, "impl: NPM");
        require(impl.V3_FACTORY() == Addresses4663.V3_FACTORY, "impl: V3_FACTORY");
        require(address(impl.FENCE()) == r.fence && impl.fence() == r.fence, "impl: FENCE");
        require(_eq(impl.CEILINGS(), DeskDefaults.ceilings()), "impl: CEILINGS");
        vm.prank(r.factory);
        try impl.initialize(address(1), address(0), DeskDefaults.laneCaps()) {
            revert("impl: initialize is not locked");
        } catch (bytes memory err) {
            require(bytes4(err) == IDeskLane.AlreadyInitialized.selector, "impl: unexpected initialize error");
        }

        // Pool
        IUniswapV3PoolMin pool = IUniswapV3PoolMin(Addresses4663.POOL_NVDA_USDG);
        require(pool.token0() == Addresses4663.USDG && pool.token1() == Addresses4663.NVDA, "pool: tokens");
        require(pool.fee() == 500 && pool.tickSpacing() == 10, "pool: fee/spacing");
        require(
            IUniswapV3FactoryMin(Addresses4663.V3_FACTORY).getPool(Addresses4663.USDG, Addresses4663.NVDA, 500)
                == address(pool),
            "pool: getPool"
        );

        // Fence table
        ChainlinkFence.TokenConfig[] memory want = DeskDefaults.fenceConfigs4663();
        address[] memory got = fence.tokens();
        require(got.length == want.length, "fence: token count");
        for (uint256 i; i < want.length; ++i) {
            ChainlinkFence.TokenConfig memory c = fence.config(want[i].token);
            require(got[i] == want[i].token, "fence: token order");
            require(c.feed == want[i].feed && c.kind == want[i].kind && c.maxAge == want[i].maxAge, "fence: config");
        }
        _logFence(fence, Addresses4663.USDG, "USDG");
        _logFence(fence, Addresses4663.NVDA, "NVDA");

        address laneAddr = vm.envOr("LANE", address(0));
        if (laneAddr != address(0)) _checkLane(factory, IDeskLane(laneAddr), r.implementation);
        console.log("CheckDeployment: OK");
    }

    function _checkLane(DeskLaneFactory factory, IDeskLane lane, address implementation) internal view {
        require(factory.isLane(address(lane)), "lane: not from this factory");
        require(_cloneTarget(address(lane)) == implementation, "lane: not a clone of the recorded implementation");
        require(lane.pool() == Addresses4663.POOL_NVDA_USDG, "lane: pool");
        require(lane.token0() == Addresses4663.USDG && lane.token1() == Addresses4663.NVDA, "lane: tokens");
        require(lane.operator() != lane.owner(), "lane: operator == owner");
        (bool open, uint8 code) = lane.riskAddingOpen();
        (int24 refTick, int24 band, uint8 refCode) = lane.refTick();
        (uint256 turnover, uint256 rr1h, uint256 rr24h, uint64 next) = lane.budgets();
        console.log("lane            ", address(lane));
        console.log("  listed        ", factory.listed(address(lane)));
        console.log("  owner         ", lane.owner());
        console.log("  operator      ", lane.operator());
        console.log("  guardian      ", lane.guardian());
        console.log("  paused        ", lane.paused());
        console.log("  riskAddingOpen", open, code);
        console.log("  refTick       ", vm.toString(refTick), vm.toString(band), refCode);
        console.log("  budgets       ", turnover, rr1h, rr24h);
        console.log("  nextRerangeAt ", next);
    }

    /// @dev The implementation an EIP-1167 clone (OpenZeppelin Clones, optionally with immutable args) delegates to,
    /// or address(0) if the code is not such a clone.
    function _cloneTarget(address clone) internal view returns (address target) {
        bytes memory code = clone.code;
        if (code.length < 45) return address(0);
        bytes10 prefix;
        bytes15 suffix;
        assembly ("memory-safe") {
            prefix := mload(add(code, 32))
            target := shr(96, mload(add(code, 42)))
            suffix := mload(add(code, 62))
        }
        if (prefix != 0x363d3d373d3d3d363d73 || suffix != 0x5af43d82803e903d91602b57fd5bf3) return address(0);
    }

    function _logFence(ChainlinkFence fence, address token, string memory name) internal view {
        (uint256 px, uint64 updatedAt, uint8 code) = fence.usdPrice(token);
        console.log(string.concat("fence ", name, " priceE18 / updatedAt / code"), px, updatedAt, code);
    }

    function _eq(IDeskTypes.Caps memory a, IDeskTypes.Caps memory b) internal pure returns (bool) {
        return keccak256(abi.encode(a)) == keccak256(abi.encode(b));
    }
}
