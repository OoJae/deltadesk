// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {ChainlinkFence} from "../src/ChainlinkFence.sol";
import {DeskLaneFactory} from "../src/DeskLaneFactory.sol";
import {DeskLaneV3} from "../src/DeskLaneV3.sol";
import {IUniswapV3FactoryMin} from "../src/interfaces/external/IUniswapV3FactoryMin.sol";
import {Addresses4663} from "./Addresses4663.sol";
import {DeskDefaults} from "./DeskDefaults.sol";

/// @notice Deploys the M2 desk on Robinhood Chain (4663) or on an anvil fork of it:
///   ChainlinkFence -> DeskLaneFactory -> DeskLaneV3 implementation -> setImplementation(1) ->
///   setPoolAllowed(NVDA/USDG, 1), then (optionally) proposeAdmin(DESK_ADMIN).
/// Env:
///   DESK_ADMIN        final factory admin; it must call acceptAdmin(). Default: the broadcaster stays admin.
///   DEPLOYMENTS_FILE  output path under deployments/. Default: deployments/<chainid>.json. Fork runs (the agent's
///                     e2e) should set e.g. deployments/4663-fork.json so the live record is never overwritten.
/// The record is written on --broadcast runs, or on any run when DEPLOYMENTS_FILE is set.
/// Usage: forge script script/Deploy.s.sol --rpc-url <url> --broadcast --account <keystore> (or --private-key on anvil)
contract Deploy is Script {
    struct Deployment {
        address fence;
        address factory;
        address implementation;
        address admin;
        address pendingAdmin;
    }

    function run() external returns (Deployment memory d) {
        _preflight();
        address finalAdmin = vm.envOr("DESK_ADMIN", address(0));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        ChainlinkFence fence = new ChainlinkFence(DeskDefaults.fenceConfigs4663());
        DeskLaneFactory factory = new DeskLaneFactory(deployer, Addresses4663.V3_FACTORY, DeskDefaults.ceilings());
        DeskLaneV3 impl = new DeskLaneV3(address(factory), Addresses4663.NPM, address(fence));
        factory.setImplementation(DeskDefaults.KIND_V3_LP, address(impl));
        factory.setPoolAllowed(Addresses4663.POOL_NVDA_USDG, DeskDefaults.KIND_V3_LP, true);
        if (finalAdmin != address(0) && finalAdmin != deployer) factory.proposeAdmin(finalAdmin);
        vm.stopBroadcast();

        d = Deployment(address(fence), address(factory), address(impl), factory.admin(), factory.pendingAdmin());
        console.log("ChainlinkFence  ", d.fence);
        console.log("DeskLaneFactory ", d.factory);
        console.log("DeskLaneV3 impl ", d.implementation);
        console.log("admin           ", d.admin);
        console.log("pendingAdmin    ", d.pendingAdmin);
        _write(d, deployer);
    }

    function _preflight() internal view {
        require(Addresses4663.V3_FACTORY.code.length != 0, "Deploy: no v3 factory (not 4663 or a fork of it)");
        require(Addresses4663.NPM.code.length != 0, "Deploy: no NPM");
        require(
            IUniswapV3FactoryMin(Addresses4663.V3_FACTORY).getPool(Addresses4663.USDG, Addresses4663.NVDA, 500)
                == Addresses4663.POOL_NVDA_USDG,
            "Deploy: NVDA/USDG pool mismatch"
        );
    }

    function _write(Deployment memory d, address deployer) internal {
        string memory path = vm.envOr("DEPLOYMENTS_FILE", string(""));
        if (bytes(path).length == 0) {
            if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
                console.log("dry run: deployment record not written (set DEPLOYMENTS_FILE or --broadcast)");
                return;
            }
            path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        }
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployedAt", block.timestamp);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "admin", d.admin);
        vm.serializeAddress(k, "pendingAdmin", d.pendingAdmin);
        vm.serializeAddress(k, "fence", d.fence);
        vm.serializeAddress(k, "factory", d.factory);
        vm.serializeAddress(k, "implementationV3", d.implementation);
        vm.serializeUint(k, "kindV3", DeskDefaults.KIND_V3_LP);
        vm.serializeAddress(k, "v3Factory", Addresses4663.V3_FACTORY);
        vm.serializeAddress(k, "npm", Addresses4663.NPM);
        string memory json = vm.serializeAddress(k, "poolNvdaUsdg", Addresses4663.POOL_NVDA_USDG);
        vm.writeJson(json, path);
        console.log("wrote", path);
    }
}
