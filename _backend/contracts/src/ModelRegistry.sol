pragma solidity ^0.8.28;

import {ENCL} from "./ENCL.sol";

/// @notice Timelocked model/code approval. Providers stake ENCL to list.
contract ModelRegistry {
    struct PolicyBinding {
        bytes32 policyHash;
        uint64 policyVersion;
    }

    struct Listing {
        bytes32 modelHash;
        bytes32 codeHash;
        address provider;
        uint64 listedAt;
        uint16 listingBps;
        uint256 staked;
        bool approved;
        bool revoked;
    }

    uint64 public constant TIMELOCK = 1 hours;
    uint256 public constant TCB_BINDING_VERSION = 1;

    address public owner;
    ENCL public encl;
    uint256 public listingStake;
    uint256 public listingCount;
    mapping(uint256 => Listing) public listings;
    mapping(bytes32 => mapping(bytes32 => uint256)) public idByHashes;
    mapping(uint256 => PolicyBinding) public listingPolicy;

    event Listed(uint256 indexed id, bytes32 modelHash, bytes32 codeHash, address provider);
    event Approved(uint256 indexed id);
    event Revoked(uint256 indexed id);
    event PolicyBound(uint256 indexed id, bytes32 indexed policyHash, uint64 policyVersion);

    constructor(address encl_, uint256 listingStake_) {
        owner = msg.sender;
        encl = ENCL(encl_);
        listingStake = listingStake_;
    }

    function list(bytes32 modelHash, bytes32 codeHash, uint16 listingBps) external returns (uint256 id) {
        return _list(modelHash, codeHash, listingBps);
    }

    /// @notice Immutable policy commitment; this does not independently verify hardware attestation.
    function listWithPolicy(bytes32 modelHash, bytes32 codeHash, uint16 listingBps, bytes32 policyHash, uint64 policyVersion)
        external returns (uint256 id) {
        require(policyHash != bytes32(0) && policyVersion != 0, "policy");
        id = _list(modelHash, codeHash, listingBps);
        listingPolicy[id] = PolicyBinding(policyHash, policyVersion);
        emit PolicyBound(id, policyHash, policyVersion);
    }

    function _list(bytes32 modelHash, bytes32 codeHash, uint16 listingBps) private returns (uint256 id) {
        require(modelHash != bytes32(0) && codeHash != bytes32(0), "hash");
        require(listingBps <= 10_000, "bps");
        require(idByHashes[modelHash][codeHash] == 0, "exists");
        uint256 stake = listingStake;
        if (stake > 0) {
            require(address(encl) != address(0), "encl");
            require(encl.transferFrom(msg.sender, address(this), stake), "stake");
        }
        id = ++listingCount;
        listings[id] = Listing({
            modelHash: modelHash,
            codeHash: codeHash,
            provider: msg.sender,
            listedAt: uint64(block.timestamp),
            listingBps: listingBps,
            staked: stake,
            approved: false,
            revoked: false
        });
        idByHashes[modelHash][codeHash] = id;
        emit Listed(id, modelHash, codeHash, msg.sender);
    }

    function approve(uint256 id) external {
        require(msg.sender == owner, "owner");
        Listing storage row = listings[id];
        require(row.listedAt != 0 && !row.revoked, "listing");
        require(block.timestamp >= row.listedAt + TIMELOCK, "timelock");
        row.approved = true;
        emit Approved(id);
    }

    /// @notice Instant approve for a local development chain only.
    function bootstrapApprove(uint256 id) external {
        require(msg.sender == owner, "owner");
        require(block.chainid == 31337, "local only");
        Listing storage row = listings[id];
        require(row.listedAt != 0 && !row.revoked, "listing");
        row.approved = true;
        emit Approved(id);
    }

    function revoke(uint256 id) external {
        require(msg.sender == owner, "owner");
        Listing storage row = listings[id];
        require(row.listedAt != 0, "listing");
        row.approved = false;
        row.revoked = true;
        uint256 stake = row.staked;
        if (stake > 0) {
            row.staked = 0;
            require(encl.transfer(row.provider, stake), "unstake");
        }
        emit Revoked(id);
    }

    /// @notice Local development restore; production revocations cannot be undone.
    function bootstrapRestore(uint256 id) external {
        require(msg.sender == owner, "owner");
        require(block.chainid == 31337, "local only");
        Listing storage row = listings[id];
        require(row.listedAt != 0, "listing");
        row.revoked = false;
        row.approved = true;
        emit Approved(id);
    }

    function isApproved(bytes32 modelHash, bytes32 codeHash) external view returns (bool) {
        uint256 id = idByHashes[modelHash][codeHash];
        if (id == 0) return false;
        Listing storage row = listings[id];
        return row.approved && !row.revoked;
    }

    function isApprovedWithPolicy(bytes32 modelHash, bytes32 codeHash, bytes32 policyHash, uint64 policyVersion)
        external view returns (bool) {
        if (policyHash == bytes32(0) || policyVersion == 0) return false;
        uint256 id = idByHashes[modelHash][codeHash];
        if (id == 0) return false;
        Listing storage row = listings[id];
        PolicyBinding storage policy = listingPolicy[id];
        return row.approved && !row.revoked && policy.policyHash == policyHash && policy.policyVersion == policyVersion;
    }

    /// @notice The provider's registered share of an inference payment, in basis points.
    function paymentTerms(uint256 id) external view returns (address provider, uint16 providerBps) {
        Listing storage row = listings[id];
        require(row.provider != address(0) && row.approved && !row.revoked, "not approved");
        return (row.provider, row.listingBps);
    }
}
