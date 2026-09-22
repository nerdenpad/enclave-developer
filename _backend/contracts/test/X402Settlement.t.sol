pragma solidity ^0.8.28;

import {Test} from "./TestBase.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {UsageMeter} from "../src/UsageMeter.sol";
import {AgentMandate} from "../src/AgentMandate.sol";

contract X402SettlementTest is Test {
    uint256 private constant KEY = 0xa11ce;
    address private payer;
    address private constant VAULT = address(0xfee);
    bytes32 private constant PAYMENT = keccak256("x402 payment");
    bytes32 private constant NONCE = keccak256("client chosen random nonce");
    bytes32 private constant AGENT = keccak256("agent");
    bytes32 private constant FUNDING_HASH = keccak256("canonical funding block");
    MockUSDC private token;
    UsageMeter private meter;
    AgentMandate private mandate;

    function setUp() public {
        vm.warp(1000);
        vm.roll(100);
        vm.setBlockhash(99, FUNDING_HASH);
        payer = vm.addr(KEY);
        token = new MockUSDC();
        meter = new UsageMeter(address(token), VAULT);
        mandate = new AgentMandate();
        mandate.setSettlementMeter(address(meter));
        meter.setMandate(address(mandate));
        token.mint(payer, 10_000);
        vm.prank(payer);
        mandate.open(AGENT, 500);
    }
    function signature(uint256 amount, bytes32 nonce) private returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), keccak256(abi.encode(
            token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, address(meter), amount, 0, 2000, nonce
        ))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, digest);
        return abi.encodePacked(r, s, v);
    }
    function directDeposit(uint256 amount, bytes32 nonce) private returns (bytes memory sig) {
        sig = signature(amount, nonce);
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := mload(add(sig, 32)) s := mload(add(sig, 64)) v := byte(0, mload(add(sig, 96))) }
        vm.prank(address(0xbad));
        token.transferWithAuthorization(payer, address(meter), amount, 0, 2000, nonce, v, r, s);
    }
    function testStandardTransferSignatureHasIndependentNonceAndAtomicMandate() public {
        meter.settleTransferAuthorized(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, signature(500, NONCE));
        assertEq(token.balanceOf(payer), 9500);
        assertEq(token.balanceOf(VAULT), 500);
        assertTrue(token.authorizationState(payer, NONCE));
        assertEq(meter.x402AuthorizationPayments(keccak256(abi.encode(payer, NONCE))), PAYMENT);
        (,, uint256 spent,) = mandate.mandates(AGENT);
        assertEq(spent, 500);
    }
    function testMandateFailureRollsBackTokenAndNonce() public {
        bytes memory sig = signature(501, NONCE);
        vm.expectRevert(bytes("mandate"));
        meter.settleTransferAuthorized(payer, 501, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig);
        assertFalse(token.authorizationState(payer, NONCE));
        assertFalse(meter.settled(PAYMENT));
        assertEq(token.balanceOf(payer), 10_000);
    }
    function testOwnerRecoversFrontRunDepositWithoutChargingPayerTwice() public {
        bytes memory sig = directDeposit(500, NONCE);
        meter.settlePrepaidTransfer(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig, UsageMeter.FundingBlock(99, FUNDING_HASH));
        assertEq(token.balanceOf(payer), 9500);
        assertEq(token.balanceOf(VAULT), 500);
        assertEq(token.balanceOf(address(meter)), 0);
        assertTrue(meter.settled(PAYMENT));
    }
    function testPrepaidDepositCannotFundAnotherPayment() public {
        bytes memory sig = directDeposit(500, NONCE);
        meter.settlePrepaidTransfer(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig, UsageMeter.FundingBlock(99, FUNDING_HASH));
        token.mint(address(meter), 500); // Unrelated deposits are not reusable with this nonce.
        vm.expectRevert(bytes("authorization replay"));
        meter.settlePrepaidTransfer(payer, 500, keccak256("other"), 0, bytes32(0), 0, 2000, NONCE, sig, UsageMeter.FundingBlock(99, FUNDING_HASH));
        assertEq(token.balanceOf(address(meter)), 500);
    }
    function testOnlyTrustedOwnerCanCreditPrepaidDeposits() public {
        bytes memory sig = directDeposit(500, NONCE);
        vm.expectRevert(bytes("owner"));
        vm.prank(payer);
        meter.settlePrepaidTransfer(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig, UsageMeter.FundingBlock(99, FUNDING_HASH));
    }
    function testUnconsumedAuthorizationCannotCreditUnrelatedDeposits() public {
        token.mint(address(meter), 500);
        bytes memory sig = signature(500, NONCE);
        vm.expectRevert(bytes("authorization unused"));
        meter.settlePrepaidTransfer(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig, UsageMeter.FundingBlock(99, FUNDING_HASH));
    }
    function testRecoveryRejectsChangedValueOrPayeeSignature() public {
        bytes memory sig = directDeposit(500, NONCE);
        vm.expectRevert(bytes("signature"));
        meter.settlePrepaidTransfer(payer, 499, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig, UsageMeter.FundingBlock(99, FUNDING_HASH));
    }
    function testExpiredAlreadyFundedAuthorizationCanBeRecovered() public {
        bytes memory sig = directDeposit(500, NONCE);
        vm.warp(2001);
        meter.settlePrepaidTransfer(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig, UsageMeter.FundingBlock(99, FUNDING_HASH));
        assertTrue(meter.settled(PAYMENT));
    }
    function testPrepaidRecoveryRejectsReorganizedFundingEvenWithOtherDeposits() public {
        bytes memory sig = directDeposit(500, NONCE);
        token.mint(address(meter), 500);
        vm.setBlockhash(99, keccak256("replacement block"));
        vm.expectRevert(bytes("funding block"));
        meter.settlePrepaidTransfer(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig, UsageMeter.FundingBlock(99, FUNDING_HASH));
        assertFalse(meter.settled(PAYMENT));
        assertEq(token.balanceOf(address(meter)), 1000);
    }
    function testPrepaidRecoveryRequiresRecentCompletedNonzeroFundingBlock() public {
        bytes memory sig = directDeposit(500, NONCE);
        vm.expectRevert(bytes("funding block"));
        meter.settlePrepaidTransfer(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig, UsageMeter.FundingBlock(100, FUNDING_HASH));
        vm.expectRevert(bytes("funding block"));
        meter.settlePrepaidTransfer(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig, UsageMeter.FundingBlock(99, bytes32(0)));
        vm.roll(356);
        vm.expectRevert(bytes("funding block"));
        meter.settlePrepaidTransfer(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig, UsageMeter.FundingBlock(99, FUNDING_HASH));
    }
    function testCancellationCannotExecuteTransferAndCannotBeReplayed() public {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), keccak256(abi.encode(
            keccak256("CancelAuthorization(address authorizer,bytes32 nonce)"), payer, NONCE
        ))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, digest);
        vm.expectRevert(bytes("signature"));
        token.cancelAuthorization(payer, NONCE, 0, r, s);
        token.cancelAuthorization(payer, NONCE, v, r, s);
        assertTrue(token.authorizationState(payer, NONCE));
        vm.expectRevert(bytes("authorization used"));
        token.cancelAuthorization(payer, NONCE, v, r, s);
        bytes memory sig = signature(500, NONCE);
        vm.expectRevert(bytes("authorization used"));
        meter.settleTransferAuthorized(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig);
        assertFalse(meter.settled(PAYMENT));
        assertEq(token.balanceOf(payer), 10000);
    }
    function testTransferRejectsUntrustedRelayerAndZeroOrRepeatedPaymentId() public {
        bytes memory sig = signature(500, NONCE);
        vm.expectRevert(bytes("relayer"));
        vm.prank(address(0xbad));
        meter.settleTransferAuthorized(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig);
        vm.expectRevert(bytes("payment"));
        meter.settleTransferAuthorized(payer, 500, bytes32(0), 0, AGENT, 0, 2000, NONCE, sig);
        meter.settleTransferAuthorized(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig);
        vm.expectRevert(bytes("payment"));
        meter.settleTransferAuthorized(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig);
        assertEq(token.balanceOf(payer), 9500);
    }
    function testMalformedNoncanonicalAndMalleableTransferSignaturesRejected() public {
        vm.expectRevert(bytes("signature"));
        meter.settleTransferAuthorized(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, hex"1234");
        bytes memory sig = signature(500, NONCE);
        sig[64] = bytes1(uint8(0));
        vm.expectRevert(bytes("v"));
        meter.settleTransferAuthorized(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig);
        sig[64] = bytes1(uint8(27));
        for (uint256 i = 32; i < 64; i++) sig[i] = bytes1(uint8(255));
        vm.expectRevert(bytes("s"));
        meter.settleTransferAuthorized(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig);
        assertFalse(token.authorizationState(payer, NONCE));
    }
    function testPrepaidRecoveryCannotExceedActualRemainingDeposits() public {
        bytes memory sig = directDeposit(500, NONCE);
        vm.prank(address(meter));
        token.transfer(VAULT, 500);
        vm.expectRevert(bytes("prepaid balance"));
        meter.settlePrepaidTransfer(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig, UsageMeter.FundingBlock(99, FUNDING_HASH));
        assertFalse(meter.settled(PAYMENT));
        assertEq(meter.x402AuthorizationPayments(keccak256(abi.encode(payer, NONCE))), bytes32(0));
    }
    function testFundingBlockAtExact256BlockBoundaryStillRecovers() public {
        bytes memory sig = directDeposit(500, NONCE);
        vm.roll(355);
        meter.settlePrepaidTransfer(payer, 500, PAYMENT, 0, AGENT, 0, 2000, NONCE, sig, UsageMeter.FundingBlock(99, FUNDING_HASH));
        assertTrue(meter.settled(PAYMENT));
    }
    function testMalleableCancellationSignatureRejectedWithoutConsumingNonce() public {
        vm.expectRevert(bytes("s"));
        token.cancelAuthorization(payer, NONCE, 27, bytes32(uint256(1)), bytes32(type(uint256).max));
        assertFalse(token.authorizationState(payer, NONCE));
    }
}
