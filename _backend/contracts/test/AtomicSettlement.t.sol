pragma solidity ^0.8.28;

import {Test} from "./TestBase.sol";
import {AgentMandate} from "../src/AgentMandate.sol";
import {UsageMeter} from "../src/UsageMeter.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {ENCL} from "../src/ENCL.sol";
import {ModelRegistry} from "../src/ModelRegistry.sol";

contract AtomicSettlementTest is Test {
    uint256 private constant KEY = 0xa11ce;
    address private payer;
    address private constant VAULT = address(0xfee);
    address private constant PROVIDER = address(0xb0b);
    address private constant STRANGER = address(0xbad);
    bytes32 private constant AGENT = keccak256("agent");
    bytes32 private constant PAYMENT = keccak256("payment");
    MockUSDC private usdc;
    UsageMeter private meter;
    AgentMandate private mandate;
    ModelRegistry private registry;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(10 days);
        payer = vm.addr(KEY);
        usdc = new MockUSDC();
        meter = new UsageMeter(address(usdc), VAULT);
        mandate = new AgentMandate();
        mandate.setSettlementMeter(address(meter));
        meter.setMandate(address(mandate));
        registry = new ModelRegistry(address(0), 0);
        meter.setModelRegistry(address(registry));
        vm.prank(PROVIDER);
        registry.list(keccak256("model"), keccak256("code"), 2000);
        registry.bootstrapApprove(1);
        usdc.mint(payer, 10_000);
        vm.prank(payer);
        usdc.approve(address(meter), type(uint256).max);
        vm.prank(payer);
        mandate.open(AGENT, 1000);
    }

    function consumed() private view returns (uint256 amount) { (,, amount,) = mandate.mandates(AGENT); }

    function signature(bytes32 id, uint256 amount, uint256 after_, uint256 before_) private returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), keccak256(abi.encode(
            usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), payer, address(meter), amount, after_, before_, id
        ))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function testAgentSettlementSpendsAndTransfersAtomically() public {
        vm.prank(payer);
        meter.settleAgent(payer, AGENT, 500, PAYMENT);
        assertEq(consumed(), 500);
        assertEq(usdc.balanceOf(VAULT), 500);
        assertEq(usdc.balanceOf(payer), 9500);
        assertTrue(meter.settled(PAYMENT));
    }

    function testExceededMandateRollsBackPayment() public {
        vm.expectRevert(bytes("mandate"));
        vm.prank(payer);
        meter.settleAgent(payer, AGENT, 1001, PAYMENT);
        assertEq(consumed(), 0);
        assertEq(usdc.balanceOf(VAULT), 0);
        assertFalse(meter.settled(PAYMENT));
    }

    function testTokenFailureRollsBackMandateAndCanRetry() public {
        vm.prank(payer);
        usdc.approve(address(meter), 0);
        vm.expectRevert(bytes("allowance"));
        vm.prank(payer);
        meter.settleAgent(payer, AGENT, 500, PAYMENT);
        assertEq(consumed(), 0);
        assertEq(mandate.spendCommitments(PAYMENT), bytes32(0));
        assertFalse(meter.settled(PAYMENT));
        vm.prank(payer);
        usdc.approve(address(meter), 500);
        vm.prank(payer);
        meter.settleAgent(payer, AGENT, 500, PAYMENT);
        assertEq(consumed(), 500);
    }

    function testPaymentReplayCannotDoubleSpendMandate() public {
        vm.prank(payer);
        meter.settleAgent(payer, AGENT, 500, PAYMENT);
        vm.expectRevert(bytes("replay"));
        vm.prank(payer);
        meter.settleAgent(payer, AGENT, 500, PAYMENT);
        assertEq(consumed(), 500);
    }

    function testPayerCannotUseSomebodyElsesMandate() public {
        vm.expectRevert(bytes("owner"));
        vm.prank(PROVIDER);
        meter.settleAgent(PROVIDER, AGENT, 1, PAYMENT);
        assertEq(consumed(), 0);
    }

    function testMeterAndMandateConfigurationAreOwnerControlled() public {
        vm.expectRevert(bytes("owner"));
        vm.prank(STRANGER);
        mandate.setSettlementMeter(address(meter));
        vm.expectRevert(bytes("owner"));
        vm.prank(STRANGER);
        meter.setMandate(address(mandate));
        vm.expectRevert(bytes("owner"));
        vm.prank(STRANGER);
        meter.setModelRegistry(address(registry));
        vm.expectRevert(bytes("meter"));
        mandate.spendFor(AGENT, payer, 1, PAYMENT);
    }

    function testMeterSpendIsIdempotentButCannotChangePaymentBinding() public {
        vm.prank(address(meter));
        mandate.spendFor(AGENT, payer, 100, PAYMENT);
        vm.prank(address(meter));
        mandate.spendFor(AGENT, payer, 100, PAYMENT);
        assertEq(consumed(), 100);
        vm.expectRevert(bytes("payment mismatch"));
        vm.prank(address(meter));
        mandate.spendFor(AGENT, payer, 101, PAYMENT);
    }

    function testModelPaymentPaysRegisteredProviderAndRecordsActualVolume() public {
        vm.prank(payer);
        meter.settleModel(payer, 501, PAYMENT, 1, AGENT);
        assertEq(consumed(), 501);
        assertEq(usdc.balanceOf(PROVIDER), 100);
        assertEq(usdc.balanceOf(VAULT), 401);
        assertEq(meter.providerEarned(1), 100);
        assertEq(meter.listingVolume(1), 501);
    }

    function testSecondLegFailureRollsBackProviderTransferAndMandate() public {
        vm.prank(payer);
        usdc.approve(address(meter), 100);
        vm.expectRevert(bytes("allowance"));
        vm.prank(payer);
        meter.settleModel(payer, 500, PAYMENT, 1, AGENT);
        assertEq(usdc.balanceOf(PROVIDER), 0);
        assertEq(usdc.balanceOf(payer), 10_000);
        assertEq(consumed(), 0);
        assertEq(meter.providerEarned(1), 0);
        assertEq(meter.listingVolume(1), 0);
    }

    function testRevokedListingCannotReceivePayment() public {
        registry.revoke(1);
        vm.expectRevert(bytes("not approved"));
        vm.prank(payer);
        meter.settleModel(payer, 500, PAYMENT, 1, AGENT);
        assertEq(consumed(), 0);
        assertEq(usdc.balanceOf(PROVIDER), 0);
    }

    function testSignedPayerUSDCSettlesWithoutMintingOrAllowance() public {
        vm.prank(payer);
        usdc.approve(address(meter), 0);
        uint256 supply = usdc.totalSupply();
        bytes memory sig = signature(PAYMENT, 500, 0, block.timestamp + 60);
        meter.settleAuthorized(payer, 500, PAYMENT, 1, AGENT, 0, block.timestamp + 60, sig);
        assertEq(usdc.totalSupply(), supply);
        assertEq(usdc.balanceOf(payer), 9500);
        assertEq(usdc.balanceOf(PROVIDER), 100);
        assertEq(usdc.balanceOf(VAULT), 400);
        assertEq(usdc.balanceOf(address(meter)), 0);
        assertEq(consumed(), 500);
        assertTrue(usdc.authorizationState(payer, PAYMENT));
    }

    function testAuthorizedPaymentRejectsRelayerRoutingSubstitution() public {
        bytes memory sig = signature(PAYMENT, 500, 0, block.timestamp + 60);
        vm.expectRevert(bytes("relayer"));
        vm.prank(STRANGER);
        meter.settleAuthorized(payer, 500, PAYMENT, 0, bytes32(0), 0, block.timestamp + 60, sig);
        assertFalse(usdc.authorizationState(payer, PAYMENT));
        assertEq(usdc.balanceOf(payer), 10_000);
    }

    function testAuthorizationRollsBackWhenMandateRejects() public {
        bytes memory sig = signature(PAYMENT, 1001, 0, block.timestamp + 60);
        vm.expectRevert(bytes("mandate"));
        meter.settleAuthorized(payer, 1001, PAYMENT, 0, AGENT, 0, block.timestamp + 60, sig);
        assertFalse(usdc.authorizationState(payer, PAYMENT));
        assertEq(usdc.balanceOf(payer), 10_000);
        assertFalse(meter.settled(PAYMENT));
    }

    function testAuthorizationRejectsTamperedAmountAndWrongDomain() public {
        bytes memory sig = signature(PAYMENT, 500, 0, block.timestamp + 60);
        vm.expectRevert(bytes("signature"));
        meter.settleAuthorized(payer, 501, PAYMENT, 0, AGENT, 0, block.timestamp + 60, sig);
        vm.chainId(1);
        vm.expectRevert(bytes("signature"));
        meter.settleAuthorized(payer, 500, PAYMENT, 0, AGENT, 0, block.timestamp + 60, sig);
    }

    function testAuthorizationHonorsExpiryAndNotBeforeBoundaries() public {
        bytes memory sig = signature(PAYMENT, 500, block.timestamp, block.timestamp + 60);
        vm.expectRevert(bytes("not yet valid"));
        meter.settleAuthorized(payer, 500, PAYMENT, 0, AGENT, block.timestamp, block.timestamp + 60, sig);
        uint256 expiry = block.timestamp + 60;
        sig = signature(PAYMENT, 500, 0, expiry);
        vm.warp(expiry);
        vm.expectRevert(bytes("expired"));
        meter.settleAuthorized(payer, 500, PAYMENT, 0, AGENT, 0, expiry, sig);
    }

    function testSignedPaymentReplayAndMalformedSignatureRejected() public {
        vm.expectRevert(bytes("signature"));
        meter.settleAuthorized(payer, 500, PAYMENT, 0, AGENT, 0, block.timestamp + 60, hex"00");
        bytes memory sig = signature(PAYMENT, 500, 0, block.timestamp + 60);
        vm.prank(payer);
        meter.settleAuthorized(payer, 500, PAYMENT, 0, AGENT, 0, block.timestamp + 60, sig);
        vm.expectRevert(bytes("replay"));
        meter.settleAuthorized(payer, 500, PAYMENT, 0, AGENT, 0, block.timestamp + 60, sig);
        assertEq(consumed(), 500);
    }

    function testNoncanonicalAuthorizationRecoveryIdsRejected() public {
        bytes memory sig = signature(PAYMENT, 500, 0, block.timestamp + 60);
        bytes1 canonicalV = sig[64];
        sig[64] = bytes1(uint8(0));
        vm.expectRevert(bytes("signature"));
        meter.settleAuthorized(payer, 500, PAYMENT, 0, bytes32(0), 0, block.timestamp + 60, sig);
        sig[64] = bytes1(uint8(1));
        vm.expectRevert(bytes("signature"));
        meter.settleAuthorized(payer, 500, PAYMENT, 0, bytes32(0), 0, block.timestamp + 60, sig);
        assertEq(usdc.balanceOf(VAULT), 0);
        assertEq(usdc.balanceOf(payer), 10_000);
        assertFalse(usdc.authorizationState(payer, PAYMENT));
        assertFalse(meter.settled(PAYMENT));
        sig[64] = canonicalV;
        meter.settleAuthorized(payer, 500, PAYMENT, 0, bytes32(0), 0, block.timestamp + 60, sig);
        assertEq(usdc.balanceOf(VAULT), 500);
    }

    function testTokenRejectsUnauthorizedReceiverAndReusedAuthorization() public {
        uint256 expiry = block.timestamp + 60;
        bytes memory sig = signature(PAYMENT, 500, 0, expiry);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly { r := mload(add(sig, 32)) s := mload(add(sig, 64)) v := byte(0, mload(add(sig, 96))) }
        vm.expectRevert(bytes("payee"));
        usdc.receiveWithAuthorization(payer, address(meter), 500, 0, expiry, PAYMENT, v, r, s);
        vm.prank(address(meter));
        usdc.receiveWithAuthorization(payer, address(meter), 500, 0, expiry, PAYMENT, v, r, s);
        vm.expectRevert(bytes("authorization used"));
        vm.prank(address(meter));
        usdc.receiveWithAuthorization(payer, address(meter), 500, 0, expiry, PAYMENT, v, r, s);
        assertEq(usdc.balanceOf(payer), 9500);
    }

    function testZeroAndFullProviderRatesConservePayment() public {
        vm.prank(PROVIDER);
        registry.list(keccak256("free-model"), keccak256("free-code"), 0);
        registry.bootstrapApprove(2);
        vm.prank(PROVIDER);
        registry.list(keccak256("full-model"), keccak256("full-code"), 10_000);
        registry.bootstrapApprove(3);
        vm.prank(payer);
        meter.settleModel(payer, 500, PAYMENT, 2, bytes32(0));
        vm.prank(payer);
        meter.settleModel(payer, 500, keccak256("second"), 3, bytes32(0));
        assertEq(usdc.balanceOf(PROVIDER), 500);
        assertEq(usdc.balanceOf(VAULT), 500);
        assertEq(meter.providerEarned(2), 0);
        assertEq(meter.providerEarned(3), 500);
    }

    function testMissingIntegrationsFailClosed() public {
        vm.expectRevert(bytes("mandate config"));
        meter.setMandate(address(0));
        vm.expectRevert(bytes("registry config"));
        meter.setModelRegistry(address(0));
        vm.expectRevert(bytes("meter"));
        mandate.setSettlementMeter(address(0));
        UsageMeter unconfigured = new UsageMeter(address(usdc), VAULT);
        vm.expectRevert(bytes("no mandate"));
        vm.prank(payer);
        unconfigured.settleAgent(payer, AGENT, 1, PAYMENT);
        vm.expectRevert(bytes("no registry"));
        vm.prank(payer);
        unconfigured.settleModel(payer, 1, PAYMENT, 1, bytes32(0));
        vm.expectRevert(bytes("agent"));
        meter.settleAgent(payer, bytes32(0), 1, PAYMENT);
        vm.expectRevert(bytes("listing"));
        meter.settleModel(payer, 1, PAYMENT, 0, bytes32(0));
    }
}
