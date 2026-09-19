// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDeskTypes} from "./IDeskTypes.sol";

/// @title DeskLane factory (FROZEN interface, M2).
/// @notice Deploys lanes as deterministic EIP-1167 clones with immutable args. createLane is permissionless: the
/// salt commits to EVERY parameter, so a front-runner can only deploy exactly what the owner asked for.
/// The admin can register implementations and allow pools for NEW clones only; existing clones never change.
interface IDeskLaneFactory {
    struct CreateParams {
        address owner; // the user's Vault wallet
        address operator; // the agent wallet; must be nonzero and != owner
        address guardian; // optional (0 = none)
        uint8 laneId; // 0 = A, 1 = B, 2 = C
        uint8 kind; // implementation kind, 1 = V3_LP
        address pool; // must be allowed for `kind` and == V3Factory.getPool(token0, token1, fee)
        IDeskTypes.Caps caps; // must be <= ceilings, field by field
        bytes32 salt; // user-chosen nonce so an owner can have several lanes per pool
    }

    event LaneCreated(
        address indexed owner, address indexed lane, uint8 indexed laneId, uint8 kind, address pool, address operator
    );
    event ImplementationSet(uint8 indexed kind, address implementation);
    event PoolAllowed(address indexed pool, uint8 indexed kind, bool allowed);
    event CeilingsSet(IDeskTypes.Caps ceilings);
    event AdminProposed(address indexed admin);
    event AdminChanged(address indexed admin);

    error NotAdmin();
    error UnknownKind(uint8 kind);
    error PoolNotAllowed(address pool);
    error PoolMismatch(address pool);
    error CapsAboveCeiling(uint8 field);
    error OperatorInvalid();

    function createLane(CreateParams calldata p) external returns (address lane);
    function predictLane(CreateParams calldata p) external view returns (address lane);

    function V3_FACTORY() external view returns (address);
    function admin() external view returns (address);
    function implementations(uint8 kind) external view returns (address);
    function poolAllowed(address pool, uint8 kind) external view returns (bool);
    function ceilings() external view returns (IDeskTypes.Caps memory);
    function isLane(address lane) external view returns (bool);
    function lanesOf(address owner) external view returns (address[] memory);

    // admin
    function setImplementation(uint8 kind, address implementation) external;
    function setPoolAllowed(address pool, uint8 kind, bool allowed) external;
    function setCeilings(IDeskTypes.Caps calldata ceilings) external;
    function proposeAdmin(address newAdmin) external;
    function acceptAdmin() external;
}
