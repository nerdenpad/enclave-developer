pragma solidity ^0.8.28;

import {Test, Vm} from "./TestBase.sol";
import {ENCL} from "../src/ENCL.sol";
import {ModelRegistry} from "../src/ModelRegistry.sol";
import {AttestationVerifier} from "../src/AttestationVerifier.sol";

contract RegistryAndReceiptsTest is Test {
    address internal constant PROVIDER = address(0xb0b);
    address internal constant STRANGER = address(0xcafe);
    bytes32 internal constant MODEL = keccak256("approved-model");
    bytes32 internal constant CODE = keccak256("measured-serving-image");
    uint256 internal constant SIGNING_KEY = 0xa11ce;
    ENCL internal token;
    ModelRegistry internal registry;
    AttestationVerifier internal verifier;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(100);
        token = new ENCL(PROVIDER, PROVIDER, PROVIDER, PROVIDER, 1000 ether);
        registry = new ModelRegistry(address(token), 10 ether);
        verifier = new AttestationVerifier(address(registry), vm.addr(SIGNING_KEY));
        vm.prank(PROVIDER);
        token.approve(address(registry), 100 ether);
    }

    function list() internal returns (uint256 id) {
        vm.prank(PROVIDER);
        return registry.list(MODEL, CODE, 200);
    }

    function approvedReceipt() internal returns (AttestationVerifier.Receipt memory r) {
        registry.bootstrapApprove(list());
        return AttestationVerifier.Receipt(MODEL, CODE, keccak256("input"), keccak256("output"), keccak256("attestation"), keccak256("invocation"), 100);
    }

    function sign(AttestationVerifier.Receipt memory r, uint256 key) internal returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(key, verifier.digest(r));
        return abi.encodePacked(rr, s, v);
    }

    function testListLocksProviderStakeAndRequiresExplicitApproval() public {
        uint256 id = list();
        assertEq(id, 1);
        assertEq(registry.idByHashes(MODEL, CODE), id);
        assertEq(token.balanceOf(PROVIDER), 990 ether);
        assertEq(token.balanceOf(address(registry)), 10 ether);
        assertFalse(registry.isApproved(MODEL, CODE));
    }

    function testListRejectsUnfundedProviderWithoutCreatingListing() public {
        vm.expectRevert(bytes("allowance"));
        vm.prank(STRANGER);
        registry.list(MODEL, CODE, 0);
        assertEq(registry.listingCount(), 0);
        assertEq(registry.idByHashes(MODEL, CODE), 0);
    }

    function testListRejectsZeroHashesAndExcessiveBps() public {
        vm.expectRevert(bytes("hash"));
        registry.list(bytes32(0), CODE, 0);
        vm.expectRevert(bytes("hash"));
        registry.list(MODEL, bytes32(0), 0);
        vm.expectRevert(bytes("bps"));
        registry.list(MODEL, CODE, 10_001);
    }

    function testDuplicateListingDoesNotConsumeStake() public {
        list();
        vm.expectRevert(bytes("exists"));
        vm.prank(PROVIDER);
        registry.list(MODEL, CODE, 0);
        assertEq(token.balanceOf(PROVIDER), 990 ether);
        assertEq(registry.listingCount(), 1);
    }

    function testApprovalIsLockedUntilExactTimelockBoundary() public {
        uint256 id = list();
        vm.warp(100 + 1 hours - 1);
        vm.expectRevert(bytes("timelock"));
        registry.approve(id);
        vm.warp(100 + 1 hours);
        registry.approve(id);
        assertTrue(registry.isApproved(MODEL, CODE));
    }

    function testOnlyOwnerCanApproveRevokeOrBootstrap() public {
        uint256 id = list();
        vm.expectRevert(bytes("owner"));
        vm.prank(PROVIDER);
        registry.approve(id);
        vm.expectRevert(bytes("owner"));
        vm.prank(PROVIDER);
        registry.revoke(id);
        vm.expectRevert(bytes("owner"));
        vm.prank(PROVIDER);
        registry.bootstrapApprove(id);
        vm.expectRevert(bytes("owner"));
        vm.prank(PROVIDER);
        registry.bootstrapRestore(id);
    }

    function testUnknownListingCannotBeApprovedOrRevoked() public {
        vm.expectRevert(bytes("listing"));
        registry.approve(1);
        vm.expectRevert(bytes("listing"));
        registry.revoke(1);
        vm.expectRevert(bytes("listing"));
        registry.bootstrapRestore(1);
        assertFalse(registry.isApproved(MODEL, CODE));
    }

    function testRevokeImmediatelyDisablesPairAndReturnsStakeOnlyOnce() public {
        uint256 id = list();
        registry.bootstrapApprove(id);
        registry.revoke(id);
        assertFalse(registry.isApproved(MODEL, CODE));
        assertEq(token.balanceOf(PROVIDER), 1000 ether);
        assertEq(token.balanceOf(address(registry)), 0);
        registry.revoke(id);
        assertEq(token.balanceOf(PROVIDER), 1000 ether);
        vm.warp(100 + 1 hours);
        vm.expectRevert(bytes("listing"));
        registry.approve(id);
        vm.expectRevert(bytes("listing"));
        registry.bootstrapApprove(id);
    }

    function testBootstrapCannotBypassTimelockOrRevocationOutsideLocalChain() public {
        uint256 id = list();
        vm.chainId(5042002);
        vm.expectRevert(bytes("local only"));
        registry.bootstrapApprove(id);
        vm.warp(100 + 1 hours);
        registry.approve(id);
        registry.revoke(id);
        vm.expectRevert(bytes("local only"));
        registry.bootstrapRestore(id);
        assertFalse(registry.isApproved(MODEL, CODE));
    }

    function testSignedReceiptEmitsOnlyHashesAndSigner() public {
        AttestationVerifier.Receipt memory r = approvedReceipt();
        bytes memory signature = sign(r, SIGNING_KEY);
        vm.recordLogs();
        bytes32 receiptHash = verifier.verifyReceipt(r, signature);
        assertEq(receiptHash, verifier.digest(r));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(verifier));
        assertEq(logs[0].topics[1], receiptHash);
        (bytes32 m, bytes32 c, bytes32 inputHash, bytes32 outputHash, bytes32 att, address signer) =
            abi.decode(logs[0].data, (bytes32, bytes32, bytes32, bytes32, bytes32, address));
        assertEq(m, r.modelHash);
        assertEq(c, r.codeHash);
        assertEq(inputHash, r.inHash);
        assertEq(outputHash, r.outHash);
        assertEq(att, r.attRef);
        assertEq(signer, vm.addr(SIGNING_KEY));
    }

    function testReceiptIsRejectedImmediatelyAfterModelRevocation() public {
        AttestationVerifier.Receipt memory r = approvedReceipt();
        bytes memory signature = sign(r, SIGNING_KEY);
        verifier.verifyReceipt(r, signature);
        registry.revoke(1);
        vm.expectRevert(bytes("not approved"));
        verifier.verifyReceipt(r, signature);
    }

    function testEveryReceiptFieldIsAuthenticated() public {
        AttestationVerifier.Receipt memory r = approvedReceipt();
        bytes memory signature = sign(r, SIGNING_KEY);
        r.inHash = keccak256("tampered input");
        vm.expectRevert(bytes("signer"));
        verifier.verifyReceipt(r, signature);
        r.inHash = keccak256("input");
        r.outHash = keccak256("tampered output");
        vm.expectRevert(bytes("signer"));
        verifier.verifyReceipt(r, signature);
        r.outHash = keccak256("output");
        r.attRef = keccak256("tampered attestation");
        vm.expectRevert(bytes("signer"));
        verifier.verifyReceipt(r, signature);
        r.attRef = keccak256("attestation");
        r.nonce = keccak256("different invocation");
        vm.expectRevert(bytes("signer"));
        verifier.verifyReceipt(r, signature);
        r.nonce = keccak256("invocation");
        r.ts += 1;
        vm.expectRevert(bytes("signer"));
        verifier.verifyReceipt(r, signature);
        r.ts -= 1;
        r.codeHash = keccak256("tampered image");
        vm.expectRevert(bytes("not approved"));
        verifier.verifyReceipt(r, signature);
        r.codeHash = CODE;
        r.modelHash = keccak256("tampered model");
        vm.expectRevert(bytes("not approved"));
        verifier.verifyReceipt(r, signature);
    }

    function testSignaturesCannotBeReplayedAgainstAnotherVerifier() public {
        AttestationVerifier.Receipt memory r = approvedReceipt();
        bytes memory signature = sign(r, SIGNING_KEY);
        AttestationVerifier other = new AttestationVerifier(address(registry), vm.addr(SIGNING_KEY));
        vm.expectRevert(bytes("signer"));
        other.verifyReceipt(r, signature);
    }

    function testSignatureCannotBeReplayedAfterChainIdChanges() public {
        AttestationVerifier.Receipt memory r = approvedReceipt();
        bytes memory signature = sign(r, SIGNING_KEY);
        bytes32 originalDomain = verifier.domainSeparator();
        vm.chainId(1);
        assertFalse(verifier.domainSeparator() == originalDomain);
        vm.expectRevert(bytes("signer"));
        verifier.verifyReceipt(r, signature);
        bytes memory currentChainSignature = sign(r, SIGNING_KEY);
        verifier.verifyReceipt(r, currentChainSignature);
    }

    function testLocalBootstrapRestoreRemainsAvailableForDevelopment() public {
        uint256 id = list();
        registry.revoke(id);
        registry.bootstrapRestore(id);
        assertTrue(registry.isApproved(MODEL, CODE));
    }

    function testListingWithRequiredStakeRejectsMissingToken() public {
        ModelRegistry broken = new ModelRegistry(address(0), 1);
        vm.expectRevert(bytes("encl"));
        broken.list(MODEL, CODE, 0);
    }

    function testSignerRotationRejectsOldKeyAndAcceptsNewKey() public {
        AttestationVerifier.Receipt memory r = approvedReceipt();
        bytes memory oldSignature = sign(r, SIGNING_KEY);
        verifier.setEnclaveSigner(vm.addr(0xb0b));
        vm.expectRevert(bytes("signer"));
        verifier.verifyReceipt(r, oldSignature);
        bytes memory newSignature = sign(r, 0xb0b);
        verifier.verifyReceipt(r, newSignature);
    }

    function testSignerRotationIsOwnerOnlyAndRejectsZero() public {
        vm.expectRevert(bytes("owner"));
        vm.prank(STRANGER);
        verifier.setEnclaveSigner(STRANGER);
        vm.expectRevert(bytes("zero"));
        verifier.setEnclaveSigner(address(0));
    }

    function testWrongSignerAndMalformedSignaturesRejected() public {
        AttestationVerifier.Receipt memory r = approvedReceipt();
        bytes memory wrongSignature = sign(r, 0xb0b);
        vm.expectRevert(bytes("signer"));
        verifier.verifyReceipt(r, wrongSignature);
        vm.expectRevert(bytes("sig"));
        verifier.verifyReceipt(r, new bytes(64));
        bytes memory invalidV = sign(r, SIGNING_KEY);
        invalidV[64] = bytes1(uint8(29));
        vm.expectRevert(bytes("v"));
        verifier.verifyReceipt(r, invalidV);
        vm.expectRevert(bytes("signer"));
        verifier.verifyReceipt(r, new bytes(65));
    }

    function testSignatureWithNormalizedRecoveryIdAccepted() public {
        AttestationVerifier.Receipt memory r = approvedReceipt();
        bytes memory signature = sign(r, SIGNING_KEY);
        signature[64] = bytes1(uint8(signature[64]) - 27);
        verifier.verifyReceipt(r, signature);
    }

    function testMalleableHighSSignatureRejected() public {
        AttestationVerifier.Receipt memory r = approvedReceipt();
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(SIGNING_KEY, verifier.digest(r));
        uint256 order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        bytes memory malleated = abi.encodePacked(rr, bytes32(order - uint256(s)), uint8(v == 27 ? 28 : 27));
        vm.expectRevert(bytes("s"));
        verifier.verifyReceipt(r, malleated);
    }

    function testVerifierRejectsZeroDependencies() public {
        vm.expectRevert(bytes("zero"));
        new AttestationVerifier(address(0), PROVIDER);
        vm.expectRevert(bytes("zero"));
        new AttestationVerifier(address(registry), address(0));
    }

    function testIdenticalInputsInSameSecondHaveDistinctNonceBoundDigests() public {
        AttestationVerifier.Receipt memory r = approvedReceipt();
        bytes32 first = verifier.digest(r);
        bytes memory firstSignature = sign(r, SIGNING_KEY);
        verifier.verifyReceipt(r, firstSignature);
        r.nonce = keccak256("second paid invocation");
        assertFalse(first == verifier.digest(r));
        vm.expectRevert(bytes("signer"));
        verifier.verifyReceipt(r, firstSignature);
        bytes memory secondSignature = sign(r, SIGNING_KEY);
        verifier.verifyReceipt(r, secondSignature);
    }

    function legacyReceipt(AttestationVerifier.Receipt memory r) internal pure returns (AttestationVerifier.LegacyReceipt memory) {
        return AttestationVerifier.LegacyReceipt(r.modelHash, r.codeHash, r.inHash, r.outHash, r.attRef, r.ts);
    }

    function signLegacy(AttestationVerifier.LegacyReceipt memory r) internal returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(SIGNING_KEY, verifier.legacyDigest(r));
        return abi.encodePacked(rr, s, v);
    }

    function testLegacyReceiptsRequireTheExplicitV1VerificationPath() public {
        AttestationVerifier.Receipt memory current = approvedReceipt();
        AttestationVerifier.LegacyReceipt memory old = legacyReceipt(current);
        bytes memory legacySignature = signLegacy(old);
        bytes32 legacyHash = verifier.verifyLegacyReceipt(old, legacySignature);
        assertEq(legacyHash, verifier.legacyDigest(old));
        assertFalse(verifier.domainSeparator() == verifier.legacyDomainSeparator());
        assertFalse(verifier.digest(current) == legacyHash);
        vm.expectRevert(bytes("signer"));
        verifier.verifyReceipt(current, legacySignature);
        bytes memory currentSignature = sign(current, SIGNING_KEY);
        vm.expectRevert(bytes("signer"));
        verifier.verifyLegacyReceipt(old, currentSignature);
    }

    function testLegacyDomainAlsoChangesOnChainFork() public {
        AttestationVerifier.LegacyReceipt memory r = legacyReceipt(approvedReceipt());
        bytes memory signature = signLegacy(r);
        bytes32 previous = verifier.legacyDomainSeparator();
        vm.chainId(5042002);
        assertFalse(verifier.legacyDomainSeparator() == previous);
        vm.expectRevert(bytes("signer"));
        verifier.verifyLegacyReceipt(r, signature);
        bytes memory currentSignature = signLegacy(r);
        verifier.verifyLegacyReceipt(r, currentSignature);
    }

    function testLegacyPathRetainsRegistryAndSignatureValidation() public {
        AttestationVerifier.LegacyReceipt memory r = legacyReceipt(approvedReceipt());
        vm.expectRevert(bytes("sig"));
        verifier.verifyLegacyReceipt(r, new bytes(64));
        bytes memory signature = signLegacy(r);
        registry.revoke(1);
        vm.expectRevert(bytes("not approved"));
        verifier.verifyLegacyReceipt(r, signature);
    }
}
