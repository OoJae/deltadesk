// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {DeskLaneFactory} from "../src/DeskLaneFactory.sol";
import {IDeskLaneFactory} from "../src/interfaces/IDeskLaneFactory.sol";
import {Addresses4663} from "./Addresses4663.sol";
import {DeskDefaults} from "./DeskDefaults.sol";
import {DeploymentFile} from "./DeploymentFile.sol";

/// @notice predictLane, then createLane with the default M2 caps. createLane is permissionless and the address
/// commits to every parameter, so it can be sent by the owner (the Vault) or by anyone on its behalf; but only a lane
/// the owner sent itself is listed in lanesOf(owner). The owner lists a lane sent for it by sending the same params.
/// Env:
///   LANE_OPERATOR (required)  the agent's Operator wallet (must differ from the owner)
///   LANE_OWNER                the Vault wallet; default: the broadcaster
///   LANE_GUARDIAN             optional watchdog key; default: none
///   LANE_ID                   0 = A (default), 1 = B, 2 = C
///   LANE_SALT                 bytes32 nonce for several lanes per owner/pool; default 0
///   DESK_FACTORY              overrides the factory from the deployment record
contract CreateLane is Script {
    function run() external returns (address lane) {
        address factoryAddr = vm.envOr("DESK_FACTORY", address(0));
        if (factoryAddr == address(0)) factoryAddr = DeploymentFile.read().factory;
        DeskLaneFactory factory = DeskLaneFactory(factoryAddr);

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        IDeskLaneFactory.CreateParams memory p = IDeskLaneFactory.CreateParams({
            owner: vm.envOr("LANE_OWNER", sender),
            operator: vm.envAddress("LANE_OPERATOR"),
            guardian: vm.envOr("LANE_GUARDIAN", address(0)),
            laneId: uint8(vm.envOr("LANE_ID", uint256(DeskDefaults.LANE_A))),
            kind: DeskDefaults.KIND_V3_LP,
            pool: Addresses4663.POOL_NVDA_USDG,
            caps: DeskDefaults.laneCaps(),
            salt: vm.envOr("LANE_SALT", bytes32(0))
        });
        address predicted = factory.predictLane(p);
        console.log("predicted lane", predicted);
        lane = factory.createLane(p);
        vm.stopBroadcast();

        require(lane == predicted, "CreateLane: address != prediction");
        console.log("lane          ", lane);
        console.log("listed        ", factory.listed(lane));
        console.log("owner         ", p.owner);
        console.log("operator      ", p.operator);
        console.log("guardian      ", p.guardian);
    }
}
