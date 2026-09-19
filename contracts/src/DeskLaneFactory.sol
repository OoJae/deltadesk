// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {IDeskLane} from "./interfaces/IDeskLane.sol";
import {IDeskLaneFactory} from "./interfaces/IDeskLaneFactory.sol";
import {IDeskTypes} from "./interfaces/IDeskTypes.sol";
import {IUniswapV3FactoryMin} from "./interfaces/external/IUniswapV3FactoryMin.sol";
import {IUniswapV3PoolMin} from "./interfaces/external/IUniswapV3PoolMin.sol";
import {CapsLib} from "./libraries/CapsLib.sol";
import {CloneArgs} from "./libraries/CloneArgs.sol";

/// @title DeskLane factory: deterministic EIP-1167 clones with immutable args.
/// @notice createLane is permissionless. The CREATE2 salt is keccak256(abi.encode(params)), so it commits to every
/// parameter and a front-runner can only deploy exactly what the owner asked for (to the same address).
/// isLane marks every clone this factory deployed (the code is a registered implementation); it says nothing about
/// who asked for the lane. lanesOf(owner) lists only lanes the owner itself confirmed by sending createLane: anyone
/// may deploy a lane naming any owner, with any operator, but only the owner can put it in its own list.
/// The admin registers implementations, allows pools per implementation kind and sets the caps ceilings; all of it
/// affects NEW clones only. Replacing a registered kind's implementation is timelocked (IMPLEMENTATION_DELAY), so the
/// code behind a predicted lane address cannot change under an in-flight createLane without a public day's notice.
/// Admin handover is two-step (proposeAdmin, acceptAdmin).
contract DeskLaneFactory is IDeskLaneFactory {
    /// @notice Delay between proposing a replacement implementation for a registered kind and applying it.
    uint256 public constant IMPLEMENTATION_DELAY = 24 hours;

    struct PendingImplementation {
        address implementation;
        uint64 eta;
    }

    address public immutable V3_FACTORY;

    address public admin;
    address public pendingAdmin;

    mapping(uint8 kind => address) public implementations;
    mapping(uint8 kind => PendingImplementation) public pendingImplementation;
    mapping(uint8 kind => bool) public kindRegistered; // a nonzero implementation was ever set for the kind
    mapping(address pool => mapping(uint8 kind => bool)) public poolAllowed;
    mapping(address lane => bool) public isLane;
    mapping(address lane => bool) public listed; // in lanesOf(its owner), i.e. confirmed by the owner
    mapping(address owner => address[]) private _lanesOf;
    IDeskTypes.Caps private _ceilings;

    event ImplementationProposed(uint8 indexed kind, address implementation, uint64 eta);
    /// @notice The owner confirmed `lane` (it sent createLane itself): lanesOf(owner) now lists it. LaneCreated alone
    /// only records a deployment, which anyone can make in any owner's name.
    event LaneListed(address indexed owner, address indexed lane);

    error ZeroAddress();
    error BadCeilings();
    error LaneExists(address lane);
    error NoPendingImplementation(uint8 kind);
    error ImplementationTimelocked(uint8 kind, uint64 eta);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address admin_, address v3Factory, IDeskTypes.Caps memory ceilings_) {
        if (admin_ == address(0) || v3Factory == address(0)) revert ZeroAddress();
        admin = admin_;
        V3_FACTORY = v3Factory;
        _setCeilings(ceilings_);
        emit AdminChanged(admin_);
    }

    // ------------------------------------------------------------------ lanes

    /// @inheritdoc IDeskLaneFactory
    /// @dev Sent by the owner, the lane is also appended to lanesOf(owner); sent by anyone else, it is deployed but
    /// not listed. The owner can list a lane someone deployed for it (or front-ran) by sending createLane with the
    /// same params: the call then returns the existing lane instead of reverting. Any other repeat reverts LaneExists.
    function createLane(CreateParams calldata p) external returns (address lane) {
        address impl = implementations[p.kind];
        if (impl == address(0)) revert UnknownKind(p.kind);
        if (!poolAllowed[p.pool][p.kind]) revert PoolNotAllowed(p.pool);
        CloneArgs.Args memory a = _laneArgs(p);
        if (IUniswapV3FactoryMin(V3_FACTORY).getPool(a.token0, a.token1, a.fee) != p.pool) revert PoolMismatch(p.pool);
        if (p.owner == address(0) || p.operator == address(0) || p.operator == p.owner) revert OperatorInvalid();
        uint8 field = CapsLib.firstAboveCeiling(p.caps, _ceilings);
        if (field != CapsLib.NONE) revert CapsAboveCeiling(field);

        bytes memory args = CloneArgs.encode(a);
        bytes32 salt = keccak256(abi.encode(p));
        lane = Clones.predictDeterministicAddressWithImmutableArgs(impl, args, salt);
        bool byOwner = msg.sender == p.owner;
        if (!isLane[lane]) {
            Clones.cloneDeterministicWithImmutableArgs(impl, args, salt);
            IDeskLane(lane).initialize(p.operator, p.guardian, p.caps);
            isLane[lane] = true;
            emit LaneCreated(p.owner, lane, p.laneId, p.kind, p.pool, p.operator);
        } else if (!byOwner || listed[lane]) {
            revert LaneExists(lane);
        }
        if (byOwner) {
            listed[lane] = true;
            _lanesOf[p.owner].push(lane);
            emit LaneListed(p.owner, lane);
        }
    }

    /// @inheritdoc IDeskLaneFactory
    /// @dev Reads the pool's tokens, fee, spacing and token decimals (they are part of the clone's init code). Only
    /// valid while implementations[p.kind] is unchanged: check pendingImplementation(p.kind) too (a replacement can
    /// apply once its eta has passed).
    function predictLane(CreateParams calldata p) external view returns (address lane) {
        address impl = implementations[p.kind];
        if (impl == address(0)) revert UnknownKind(p.kind);
        return Clones.predictDeterministicAddressWithImmutableArgs(
            impl, CloneArgs.encode(_laneArgs(p)), keccak256(abi.encode(p))
        );
    }

    /// @notice The clone immutable args createLane would use for `p`.
    function laneArgs(CreateParams calldata p) external view returns (bytes memory) {
        return CloneArgs.encode(_laneArgs(p));
    }

    function ceilings() external view returns (IDeskTypes.Caps memory) {
        return _ceilings;
    }

    /// @notice Lanes `owner` created (or confirmed) itself, in order. Lanes deployed for it by others are not listed.
    function lanesOf(address owner) external view returns (address[] memory) {
        return _lanesOf[owner];
    }

    // ------------------------------------------------------------------ admin (new clones only)

    /// @inheritdoc IDeskLaneFactory
    /// @dev Applies at once only when it cannot put new code behind an address predictLane already returned: the
    /// kind's first registration, disabling the kind (address(0), which also drops a pending replacement) and
    /// re-affirming the current implementation (which cancels a pending replacement). Any other change, including
    /// re-enabling a disabled kind, becomes pending for IMPLEMENTATION_DELAY (ImplementationProposed) and takes
    /// effect through applyImplementation; a new proposal supersedes the pending one and restarts the delay.
    function setImplementation(uint8 kind, address implementation) external onlyAdmin {
        if (implementation != address(0) && implementation.code.length == 0) revert ZeroAddress();
        if (implementation == address(0) || implementation == implementations[kind] || !kindRegistered[kind]) {
            delete pendingImplementation[kind];
            _setImplementation(kind, implementation);
            return;
        }
        uint64 eta = uint64(block.timestamp + IMPLEMENTATION_DELAY);
        pendingImplementation[kind] = PendingImplementation(implementation, eta);
        emit ImplementationProposed(kind, implementation, eta);
    }

    /// @notice Apply a replacement implementation proposed by setImplementation once its eta has passed.
    function applyImplementation(uint8 kind) external onlyAdmin {
        PendingImplementation memory pi = pendingImplementation[kind];
        if (pi.implementation == address(0)) revert NoPendingImplementation(kind);
        if (block.timestamp < pi.eta) revert ImplementationTimelocked(kind, pi.eta);
        delete pendingImplementation[kind];
        _setImplementation(kind, pi.implementation);
    }

    /// @inheritdoc IDeskLaneFactory
    function setPoolAllowed(address pool, uint8 kind, bool allowed) external onlyAdmin {
        poolAllowed[pool][kind] = allowed;
        emit PoolAllowed(pool, kind, allowed);
    }

    /// @inheritdoc IDeskLaneFactory
    /// @dev Direction of each field: the ceiling is an UPPER bound on maxDeployUsd6, turnoverUsd6PerDay, placeBandBps,
    /// maxTickDelta, maxWidthTicks, reranges1h, reranges24h, maxDeadlineAhead and maxRanges, and a LOWER bound on
    /// minWidthTicks and minRerangeInterval (a lane's caps must be >= those). Implementations copy the ceilings at
    /// their own deployment, so deploy a new implementation after loosening them.
    function setCeilings(IDeskTypes.Caps calldata ceilings_) external onlyAdmin {
        _setCeilings(ceilings_);
    }

    /// @inheritdoc IDeskLaneFactory
    function proposeAdmin(address newAdmin) external onlyAdmin {
        pendingAdmin = newAdmin;
        emit AdminProposed(newAdmin);
    }

    /// @inheritdoc IDeskLaneFactory
    function acceptAdmin() external {
        if (msg.sender != pendingAdmin || msg.sender == address(0)) revert NotAdmin();
        admin = msg.sender;
        delete pendingAdmin;
        emit AdminChanged(msg.sender);
    }

    // ------------------------------------------------------------------ internal

    function _laneArgs(CreateParams calldata p) internal view returns (CloneArgs.Args memory a) {
        IUniswapV3PoolMin pool = IUniswapV3PoolMin(p.pool);
        a.owner = p.owner;
        a.laneId = p.laneId;
        a.pool = p.pool;
        a.token0 = pool.token0();
        a.token1 = pool.token1();
        a.fee = pool.fee();
        a.tickSpacing = pool.tickSpacing();
        a.dec0 = IERC20Metadata(a.token0).decimals();
        a.dec1 = IERC20Metadata(a.token1).decimals();
    }

    function _setImplementation(uint8 kind, address implementation) internal {
        implementations[kind] = implementation;
        if (implementation != address(0)) kindRegistered[kind] = true;
        emit ImplementationSet(kind, implementation);
    }

    function _setCeilings(IDeskTypes.Caps memory c) internal {
        if (c.minWidthTicks > c.maxWidthTicks || c.maxRanges == 0) revert BadCeilings();
        _ceilings = c;
        emit CeilingsSet(c);
    }
}
