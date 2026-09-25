pragma solidity ^0.8.28;

import {Test} from "./TestBase.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {UsageMeter} from "../src/UsageMeter.sol";

contract RelayRolesTest is Test {
    uint256 private constant KEY = 0xa11ce;
    address private constant RELAY = address(0x1234);
    address private constant NEXT = address(0x5678);
    address private constant VAULT = address(0xfee);
    bytes32 private constant NONCE = keccak256("payment nonce");
    bytes32 private constant PAYMENT = keccak256("payment id");
    MockUSDC private token;
    UsageMeter private meter;
    address private payer;

    function setUp() public {
        vm.warp(1000);
        payer = vm.addr(KEY);
        token = new MockUSDC();
        meter = new UsageMeter(address(token), VAULT);
        token.mint(payer, 1000);
        meter.setRelay(RELAY);
    }
    function signature() private returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), keccak256(abi.encode(
            token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, address(meter), 100, 0, 2000, NONCE
        ))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, digest);
        return abi.encodePacked(r, s, v);
    }
    function settle(bytes memory sig) private {
        meter.settleTransferAuthorized(payer, 100, PAYMENT, 0, bytes32(0), 0, 2000, NONCE, sig);
    }
    function testRelaySettlesButCannotChangeConfiguration() public {
        bytes memory sig = signature();
        vm.prank(RELAY); settle(sig);
        assertEq(token.balanceOf(VAULT), 100);
        assertEq(meter.owner(), address(this));
        vm.expectRevert(bytes("owner")); vm.prank(RELAY); meter.setRelay(NEXT);
        vm.expectRevert(bytes("owner")); vm.prank(RELAY); meter.setConfidential(address(1));
        vm.expectRevert(bytes("owner")); vm.prank(RELAY); meter.setMandate(address(1));
        vm.expectRevert(bytes("owner")); vm.prank(RELAY); meter.setModelRegistry(address(1));
    }
    function testRotationRevokesOldRelayAndOwnerCannotActAsRelay() public {
        bytes memory sig = signature();
        meter.setRelay(NEXT);
        vm.expectRevert(bytes("relayer")); vm.prank(RELAY); settle(sig);
        vm.expectRevert(bytes("relayer")); settle(sig);
        vm.prank(NEXT); settle(sig);
        assertEq(token.balanceOf(payer), 900);
    }
    function testPauseStopsRelayButPayerCanSubmitOwnAuthorization() public {
        bytes memory sig = signature();
        meter.setRelay(address(0));
        vm.expectRevert(bytes("relayer")); vm.prank(RELAY); settle(sig);
        vm.prank(payer); settle(sig);
        assertEq(token.balanceOf(VAULT), 100);
    }
    function testRecoveryUsesRelayWithoutDebitingAgain() public {
        bytes memory sig = signature();
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := mload(add(sig, 32)) s := mload(add(sig, 64)) v := byte(0, mload(add(sig, 96))) }
        token.transferWithAuthorization(payer, address(meter), 100, 0, 2000, NONCE, v, r, s);
        vm.roll(100); vm.setBlockhash(99, keccak256("funding"));
        UsageMeter.FundingBlock memory funding = UsageMeter.FundingBlock(99, keccak256("funding"));
        vm.expectRevert(bytes("relayer"));
        meter.settlePrepaidTransfer(payer, 100, PAYMENT, 0, bytes32(0), 0, 2000, NONCE, sig, funding);
        vm.prank(RELAY);
        meter.settlePrepaidTransfer(payer, 100, PAYMENT, 0, bytes32(0), 0, 2000, NONCE, sig, funding);
        assertEq(token.balanceOf(payer), 900);
        assertEq(token.balanceOf(VAULT), 100);
    }
}
