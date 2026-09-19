// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// @notice Deploys the REAL Uniswap v3 factory and NonfungiblePositionManager from the compiled npm artifacts
/// (npm packages v3-core 1.0.1 and v3-periphery 1.4.4). Their pool init code hash matches the canonical
/// 0xe34f199b...8b54 that the NPM uses to derive pool addresses.
library V3Deployer {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal constant FACTORY_ARTIFACT =
        "node_modules/@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";
    string internal constant NPM_ARTIFACT =
        "node_modules/@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json";

    /// @notice Deploy the factory and an NPM(factory, weth, descriptor). Any address works for weth and the
    /// descriptor unless a test calls the ETH or tokenURI paths.
    function deploy(address weth, address descriptor) internal returns (address factory, address npm) {
        factory = _create(vm.getCode(FACTORY_ARTIFACT));
        npm = _create(abi.encodePacked(vm.getCode(NPM_ARTIFACT), abi.encode(factory, weth, descriptor)));
    }

    function _create(bytes memory initCode) private returns (address addr) {
        assembly ("memory-safe") {
            addr := create(0, add(initCode, 32), mload(initCode))
        }
        require(addr != address(0), "V3Deployer: create failed");
    }
}
