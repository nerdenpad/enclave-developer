pragma solidity ^0.8.28;

import {Test} from "./TestBase.sol";
import {ENCL} from "../src/ENCL.sol";
import {ModelRegistry} from "../src/ModelRegistry.sol";
import {AttestationVerifier} from "../src/AttestationVerifier.sol";
import {AgentMandate} from "../src/AgentMandate.sol";

contract EnclaveTest is Test {
    function testGenesisSplit() public {
        ENCL token = new ENCL(address(1), address(2), address(3), address(4), 1_000_000 ether);
        assertEq(token.balanceOf(address(1)), 800_000 ether);
        assertEq(token.balanceOf(address(2)), 100_000 ether);
        assertEq(token.balanceOf(address(3)), 50_000 ether);
        assertEq(token.balanceOf(address(4)), 50_000 ether);
    }

    function testRevokedModelRejected() public {
        ENCL token = new ENCL(address(this), address(this), address(this), address(this), 1_000_000 ether);
        ModelRegistry registry = new ModelRegistry(address(token), 0);
        bytes32 modelHash = keccak256("m");
        bytes32 codeHash = keccak256("c");
        uint256 id = registry.list(modelHash, codeHash, 0);
        registry.bootstrapApprove(id);
        registry.revoke(id);
        assertFalse(registry.isApproved(modelHash, codeHash));
    }

    function testVerifierRejectsUnapproved() public {
        ENCL token = new ENCL(address(this), address(this), address(this), address(this), 1_000_000 ether);
        ModelRegistry registry = new ModelRegistry(address(token), 0);
        AttestationVerifier verifier = new AttestationVerifier(address(registry), address(this));
        AttestationVerifier.Receipt memory r = AttestationVerifier.Receipt({
            modelHash: keccak256("m"),
            codeHash: keccak256("c"),
            inHash: keccak256("i"),
            outHash: keccak256("o"),
            attRef: keccak256("a"),
            nonce: keccak256("invocation"),
            ts: 1
        });
        vm.expectRevert(bytes("not approved"));
        verifier.verifyReceipt(r, new bytes(65));
    }

    function testMandateSpendCap() public {
        AgentMandate mandates = new AgentMandate();
        bytes32 agent = keccak256("agent");
        mandates.open(agent, 100);
        mandates.spend(agent, 90);
        vm.expectRevert(bytes("mandate"));
        mandates.spend(agent, 11);
    }
}
