// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// @notice Reads the record written by Deploy.s.sol (DEPLOYMENTS_FILE, default deployments/<chainid>.json).
library DeploymentFile {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct Record {
        address fence;
        address factory;
        address implementation;
    }

    function path() internal view returns (string memory p) {
        p = vm.envOr("DEPLOYMENTS_FILE", string(""));
        if (bytes(p).length == 0) p = string.concat("deployments/", vm.toString(block.chainid), ".json");
    }

    function read() internal view returns (Record memory r) {
        string memory json = vm.readFile(path());
        r.fence = vm.parseJsonAddress(json, ".fence");
        r.factory = vm.parseJsonAddress(json, ".factory");
        r.implementation = vm.parseJsonAddress(json, ".implementationV3");
    }
}
