pragma solidity ^0.8.28;

import {ModelRegistry} from "./ModelRegistry.sol";

/// @notice Verifies EIP-712 inference receipts against approved {modelHash, codeHash}.
contract AttestationVerifier {
    bytes32 public constant RECEIPT_TYPEHASH = keccak256(
        "InferenceReceipt(bytes32 modelHash,bytes32 codeHash,bytes32 inHash,bytes32 outHash,bytes32 attRef,bytes32 nonce,uint64 ts)"
    );
    bytes32 public constant LEGACY_RECEIPT_TYPEHASH = keccak256(
        "InferenceReceipt(bytes32 modelHash,bytes32 codeHash,bytes32 inHash,bytes32 outHash,bytes32 attRef,uint64 ts)"
    );

    struct Receipt {
        bytes32 modelHash;
        bytes32 codeHash;
        bytes32 inHash;
        bytes32 outHash;
        bytes32 attRef;
        bytes32 nonce;
        uint64 ts;
    }

    /// @notice Historical version-1 receipts remain explicitly verifiable during migration.
    struct LegacyReceipt {
        bytes32 modelHash;
        bytes32 codeHash;
        bytes32 inHash;
        bytes32 outHash;
        bytes32 attRef;
        uint64 ts;
    }

    ModelRegistry public immutable registry;
    address public enclaveSigner;
    address public owner;
    uint256 private immutable initialChainId;
    bytes32 private immutable initialDomainSeparator;
    bytes32 private immutable initialLegacyDomainSeparator;

    event Verified(
        bytes32 indexed receiptHash,
        bytes32 modelHash,
        bytes32 codeHash,
        bytes32 inHash,
        bytes32 outHash,
        bytes32 attRef,
        address signer
    );

    constructor(address registry_, address enclaveSigner_) {
        require(registry_ != address(0) && enclaveSigner_ != address(0), "zero");
        registry = ModelRegistry(registry_);
        enclaveSigner = enclaveSigner_;
        owner = msg.sender;
        initialChainId = block.chainid;
        initialDomainSeparator = _domainSeparator("2");
        initialLegacyDomainSeparator = _domainSeparator("1");
    }

    function _domainSeparator(string memory version) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("ENCLAVE")),
                keccak256(bytes(version)),
                block.chainid,
                address(this)
            )
        );
    }

    function domainSeparator() public view returns (bytes32) {
        // A chain fork must not retain the original chain's signature domain.
        return block.chainid == initialChainId ? initialDomainSeparator : _domainSeparator("2");
    }

    function legacyDomainSeparator() public view returns (bytes32) {
        return block.chainid == initialChainId ? initialLegacyDomainSeparator : _domainSeparator("1");
    }

    function setEnclaveSigner(address next) external {
        require(msg.sender == owner, "owner");
        require(next != address(0), "zero");
        enclaveSigner = next;
    }

    function digest(Receipt calldata r) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(RECEIPT_TYPEHASH, r.modelHash, r.codeHash, r.inHash, r.outHash, r.attRef, r.nonce, r.ts)
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function legacyDigest(LegacyReceipt calldata r) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(LEGACY_RECEIPT_TYPEHASH, r.modelHash, r.codeHash, r.inHash, r.outHash, r.attRef, r.ts)
        );
        return keccak256(abi.encodePacked("\x19\x01", legacyDomainSeparator(), structHash));
    }

    function verifyReceipt(Receipt calldata r, bytes calldata sig) external returns (bytes32 receiptHash) {
        require(registry.isApproved(r.modelHash, r.codeHash), "not approved");
        require(sig.length == 65, "sig");
        receiptHash = digest(r);
        address recovered = _recover(receiptHash, sig);
        require(recovered == enclaveSigner, "signer");
        emit Verified(receiptHash, r.modelHash, r.codeHash, r.inHash, r.outHash, r.attRef, recovered);
    }

    function verifyLegacyReceipt(LegacyReceipt calldata r, bytes calldata sig) external returns (bytes32 receiptHash) {
        require(registry.isApproved(r.modelHash, r.codeHash), "not approved");
        require(sig.length == 65, "sig");
        receiptHash = legacyDigest(r);
        address recovered = _recover(receiptHash, sig);
        require(recovered == enclaveSigner, "signer");
        emit Verified(receiptHash, r.modelHash, r.codeHash, r.inHash, r.outHash, r.attRef, recovered);
    }

    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "v");
        // Accept only canonical secp256k1 signatures, matching off-chain verifiers.
        require(uint256(s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0, "s");
        return ecrecover(hash, v, r, s);
    }
}
