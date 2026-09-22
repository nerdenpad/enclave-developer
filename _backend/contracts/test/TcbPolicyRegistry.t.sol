pragma solidity ^0.8.28;

import {Test, Vm} from "./TestBase.sol";
import {ENCL} from "../src/ENCL.sol";
import {ModelRegistry} from "../src/ModelRegistry.sol";

contract TcbPolicyRegistryTest is Test {
    address private constant PROVIDER = address(0xb0b);
    address private constant STRANGER = address(0xbad);
    bytes32 private constant MODEL = keccak256("model");
    bytes32 private constant CODE = keccak256("code");
    bytes32 private constant POLICY = keccak256("canonical policy");
    uint64 private constant VERSION = 7;
    ENCL private token;
    ModelRegistry private registry;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(100);
        token = new ENCL(PROVIDER, PROVIDER, PROVIDER, PROVIDER, 1000 ether);
        registry = new ModelRegistry(address(token), 10 ether);
        vm.prank(PROVIDER);
        token.approve(address(registry), 100 ether);
    }

    function list() private returns (uint256) {
        vm.prank(PROVIDER);
        return registry.listWithPolicy(MODEL, CODE, 200, POLICY, VERSION);
    }

    function assertBinding(uint256 id) private view {
        (bytes32 hash, uint64 version) = registry.listingPolicy(id);
        assertEq(hash, POLICY);
        assertEq(version, VERSION);
    }

    function testPolicyBindingPreservesListingAbiAndStakeAccounting() public {
        uint256 id = list();
        assertEq(registry.TCB_BINDING_VERSION(), 1);
        assertBinding(id);
        (bytes32 model, bytes32 code, address provider, uint64 timestamp, uint16 bps, uint256 stake, bool approved, bool revoked) = registry.listings(id);
        assertEq(model, MODEL); assertEq(code, CODE); assertEq(provider, PROVIDER);
        assertEq(timestamp, 100); assertEq(bps, 200); assertEq(stake, 10 ether);
        assertFalse(approved); assertFalse(revoked);
        assertEq(token.balanceOf(PROVIDER), 990 ether);
    }

    function testPolicyRequiresOwnerApprovalAfterTheExactTimelock() public {
        uint256 id = list();
        assertFalse(registry.isApprovedWithPolicy(MODEL, CODE, POLICY, VERSION));
        vm.warp(100 + 1 hours - 1);
        vm.expectRevert(bytes("timelock")); registry.approve(id);
        vm.warp(100 + 1 hours);
        vm.expectRevert(bytes("owner")); vm.prank(PROVIDER); registry.approve(id);
        registry.approve(id);
        assertTrue(registry.isApprovedWithPolicy(MODEL, CODE, POLICY, VERSION));
        assertTrue(registry.isApproved(MODEL, CODE));
    }

    function testLegacyListingCannotPassPolicyApprovalEvenWithZeroBinding() public {
        vm.prank(PROVIDER);
        uint256 id = registry.list(MODEL, CODE, 200);
        registry.bootstrapApprove(id);
        (bytes32 hash, uint64 version) = registry.listingPolicy(id);
        assertEq(hash, bytes32(0)); assertEq(version, 0);
        assertTrue(registry.isApproved(MODEL, CODE));
        assertFalse(registry.isApprovedWithPolicy(MODEL, CODE, POLICY, VERSION));
        assertFalse(registry.isApprovedWithPolicy(MODEL, CODE, bytes32(0), 0));
        vm.expectRevert(bytes("exists")); list();
        assertEq(registry.listingCount(), 1);
        assertEq(token.balanceOf(PROVIDER), 990 ether);
    }

    function testPolicyApprovalRejectsWrongHashVersionAndMissingModel() public {
        registry.bootstrapApprove(list());
        assertFalse(registry.isApprovedWithPolicy(MODEL, CODE, keccak256("other"), VERSION));
        assertFalse(registry.isApprovedWithPolicy(MODEL, CODE, POLICY, VERSION + 1));
        assertFalse(registry.isApprovedWithPolicy(MODEL, CODE, POLICY, 0));
        assertFalse(registry.isApprovedWithPolicy(MODEL, CODE, bytes32(0), VERSION));
        assertFalse(registry.isApprovedWithPolicy(keccak256("other model"), CODE, POLICY, VERSION));
    }

    function testPolicyBindingCannotBeReplacedBeforeOrAfterApproval() public {
        uint256 id = list();
        vm.expectRevert(bytes("exists")); vm.prank(PROVIDER);
        registry.listWithPolicy(MODEL, CODE, 300, keccak256("replacement"), VERSION + 1);
        registry.bootstrapApprove(id);
        vm.expectRevert(bytes("exists")); vm.prank(PROVIDER);
        registry.listWithPolicy(MODEL, CODE, 300, keccak256("replacement"), VERSION + 1);
        assertBinding(id);
        assertEq(token.balanceOf(PROVIDER), 990 ether);
    }

    function testMissingPolicyIsRejectedBeforeProviderStakeMoves() public {
        vm.expectRevert(bytes("policy")); vm.prank(PROVIDER);
        registry.listWithPolicy(MODEL, CODE, 200, bytes32(0), VERSION);
        vm.expectRevert(bytes("policy")); vm.prank(PROVIDER);
        registry.listWithPolicy(MODEL, CODE, 200, POLICY, 0);
        assertEq(registry.listingCount(), 0);
        assertEq(token.balanceOf(PROVIDER), 1000 ether);
    }

    function testProviderStakeFailureDoesNotLeaveAnyPolicyBinding() public {
        vm.expectRevert(bytes("allowance")); vm.prank(STRANGER);
        registry.listWithPolicy(MODEL, CODE, 200, POLICY, VERSION);
        assertEq(registry.listingCount(), 0);
        (bytes32 hash, uint64 version) = registry.listingPolicy(1);
        assertEq(hash, bytes32(0)); assertEq(version, 0);
    }

    function testRevocationDisablesExactPolicyAndPreservesItsImmutableHistory() public {
        uint256 id = list(); registry.bootstrapApprove(id);
        vm.expectRevert(bytes("owner")); vm.prank(STRANGER); registry.revoke(id);
        registry.revoke(id);
        assertFalse(registry.isApprovedWithPolicy(MODEL, CODE, POLICY, VERSION));
        assertBinding(id);
        assertEq(token.balanceOf(PROVIDER), 1000 ether);
        vm.expectRevert(bytes("listing")); registry.approve(id);
    }

    function testPolicyBindingCannotBypassProductionBootstrapRestrictions() public {
        uint256 id = list(); vm.chainId(5042002);
        vm.expectRevert(bytes("local only")); registry.bootstrapApprove(id);
        vm.warp(100 + 1 hours); registry.approve(id); registry.revoke(id);
        vm.expectRevert(bytes("local only")); registry.bootstrapRestore(id);
        assertFalse(registry.isApprovedWithPolicy(MODEL, CODE, POLICY, VERSION));
        assertBinding(id);
    }

    function testPolicyBoundEventProvidesTheExactCommitment() public {
        vm.recordLogs(); uint256 id = list(); Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory last = logs[logs.length - 1];
        assertEq(last.emitter, address(registry));
        assertEq(last.topics[0], keccak256("PolicyBound(uint256,bytes32,uint64)"));
        assertEq(last.topics[1], bytes32(id)); assertEq(last.topics[2], POLICY);
        assertEq(abi.decode(last.data, (uint64)), VERSION);
    }
}
