pragma solidity ^0.8.28;

import {Test, Vm} from "./TestBase.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {UsageMeter} from "../src/UsageMeter.sol";
import {AgentMandate} from "../src/AgentMandate.sol";
import {MockConfidentialTransfer} from "../src/MockConfidentialTransfer.sol";
import {IArcConfidentialTransfer} from "../src/interfaces/IArcConfidentialTransfer.sol";

contract RejectingConfidentialTransfer is IArcConfidentialTransfer {
    function confidentialTransfer(address, bytes calldata) external pure returns (bool) { return false; }
}

contract PaymentsAndMandatesTest is Test {
    address internal constant PAYER = address(0xa11ce);
    address internal constant ATTACKER = address(0xbad);
    address internal constant TREASURY = address(0x100);
    address internal constant STAKERS = address(0x200);
    address internal constant PROVIDERS = address(0x300);
    address internal constant ECOSYSTEM = address(0x400);
    bytes32 internal constant RECEIPT = keccak256("paid receipt");
    bytes32 internal constant AGENT = keccak256("sealed agent");
    MockUSDC internal usdc;
    FeeVault internal vault;
    UsageMeter internal meter;
    AgentMandate internal mandate;

    function setUp() public {
        vm.warp(10 days);
        usdc = new MockUSDC();
        vault = new FeeVault(address(usdc));
        meter = new UsageMeter(address(usdc), address(vault));
        mandate = new AgentMandate();
        usdc.mint(PAYER, 1_000_000);
        vm.prank(PAYER);
        usdc.approve(address(meter), 1_000_000);
    }

    function testSettlementMovesActualUSDCAndMarksReceipt() public {
        vm.prank(PAYER);
        meter.settle(PAYER, 1200, RECEIPT);
        assertEq(usdc.balanceOf(PAYER), 998800);
        assertEq(usdc.balanceOf(address(vault)), 1200);
        assertEq(usdc.allowance(PAYER, address(meter)), 998800);
        assertEq(meter.spent(PAYER), 1200);
        assertTrue(meter.settled(RECEIPT));
    }

    function testStrangerCannotDrainApprovedPayerAllowance() public {
        vm.expectRevert(bytes("payer"));
        vm.prank(ATTACKER);
        meter.settle(PAYER, 1_000_000, RECEIPT);
        assertEq(usdc.balanceOf(PAYER), 1_000_000);
        assertEq(usdc.allowance(PAYER, address(meter)), 1_000_000);
        assertEq(meter.spent(PAYER), 0);
        assertFalse(meter.settled(RECEIPT));
    }

    function testSettlementReplayCannotChargeTwice() public {
        vm.prank(PAYER);
        meter.settle(PAYER, 100, RECEIPT);
        vm.expectRevert(bytes("replay"));
        vm.prank(PAYER);
        meter.settle(PAYER, 100, RECEIPT);
        assertEq(meter.spent(PAYER), 100);
        assertEq(usdc.balanceOf(address(vault)), 100);
    }

    function testRevertingTransferRollsBackReceiptAndUsageThenCanRetry() public {
        vm.prank(PAYER);
        usdc.approve(address(meter), 0);
        vm.expectRevert(bytes("allowance"));
        vm.prank(PAYER);
        meter.settle(PAYER, 100, RECEIPT);
        assertFalse(meter.settled(RECEIPT));
        assertEq(meter.spent(PAYER), 0);
        assertEq(usdc.balanceOf(address(vault)), 0);
        vm.prank(PAYER);
        usdc.approve(address(meter), 100);
        vm.prank(PAYER);
        meter.settle(PAYER, 100, RECEIPT);
        assertTrue(meter.settled(RECEIPT));
    }

    function testInsufficientBalanceRollsBackSettlement() public {
        vm.prank(PAYER);
        usdc.approve(address(meter), type(uint256).max);
        vm.expectRevert(bytes("balance"));
        vm.prank(PAYER);
        meter.settle(PAYER, 1_000_001, RECEIPT);
        assertFalse(meter.settled(RECEIPT));
        assertEq(meter.spent(PAYER), 0);
    }

    function testSettlementRejectsZeroAmountAndEmptyReceipt() public {
        vm.expectRevert(bytes("amount"));
        vm.prank(PAYER);
        meter.settle(PAYER, 0, RECEIPT);
        vm.expectRevert(bytes("receipt"));
        vm.prank(PAYER);
        meter.settle(PAYER, 1, bytes32(0));
    }

    function testMeterRejectsZeroDependencies() public {
        vm.expectRevert(bytes("zero"));
        new UsageMeter(address(0), address(vault));
        vm.expectRevert(bytes("zero"));
        new UsageMeter(address(usdc), address(0));
    }

    function testOnlyOwnerCanConfigureConfidentialHook() public {
        vm.expectRevert(bytes("owner"));
        vm.prank(ATTACKER);
        meter.setConfidential(ATTACKER);
    }

    function testConfidentialSettlementRequiresConfiguredHook() public {
        vm.expectRevert(bytes("no confidential"));
        vm.prank(PAYER);
        meter.settleConfidential(PAYER, hex"1234", RECEIPT);
        assertFalse(meter.settled(RECEIPT));
    }

    function testConfidentialSettlementRejectsImpersonationAndEmptyPayload() public {
        meter.setConfidential(address(new MockConfidentialTransfer()));
        vm.expectRevert(bytes("payer"));
        vm.prank(ATTACKER);
        meter.settleConfidential(PAYER, hex"1234", RECEIPT);
        vm.expectRevert(bytes("amount"));
        vm.prank(PAYER);
        meter.settleConfidential(PAYER, hex"", RECEIPT);
        vm.expectRevert(bytes("receipt"));
        vm.prank(PAYER);
        meter.settleConfidential(PAYER, hex"1234", bytes32(0));
    }

    function testRejectingConfidentialHookRollsBackAndAllowsRetry() public {
        meter.setConfidential(address(new RejectingConfidentialTransfer()));
        vm.expectRevert(bytes("shielded"));
        vm.prank(PAYER);
        meter.settleConfidential(PAYER, hex"1234", RECEIPT);
        assertFalse(meter.settled(RECEIPT));
        meter.setConfidential(address(new MockConfidentialTransfer()));
        vm.prank(PAYER);
        meter.settleConfidential(PAYER, hex"1234", RECEIPT);
        assertTrue(meter.settled(RECEIPT));
    }

    function testReplayProtectionIsSharedAcrossPublicAndConfidentialPaths() public {
        meter.setConfidential(address(new MockConfidentialTransfer()));
        vm.prank(PAYER);
        meter.settle(PAYER, 1, RECEIPT);
        vm.expectRevert(bytes("replay"));
        vm.prank(PAYER);
        meter.settleConfidential(PAYER, hex"1234", RECEIPT);
        bytes32 second = keccak256("second");
        vm.prank(PAYER);
        meter.settleConfidential(PAYER, hex"1234", second);
        vm.expectRevert(bytes("replay"));
        vm.prank(PAYER);
        meter.settle(PAYER, 1, second);
    }

    /// @dev Characterizes the development stub; this is NOT proof of confidential payment acceptance.
    function testLocalConfidentialMockOnlyExercisesHookNotTransfer() public {
        meter.setConfidential(address(new MockConfidentialTransfer()));
        vm.prank(PAYER);
        meter.settleConfidential(PAYER, hex"1234", RECEIPT);
        assertTrue(meter.settled(RECEIPT));
        assertEq(usdc.balanceOf(PAYER), 1_000_000);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(meter.spent(PAYER), 0);
    }

    function testUnverifiedConfidentialHookCannotSettleOnExternalChain() public {
        meter.setConfidential(address(new MockConfidentialTransfer()));
        vm.chainId(1);
        vm.expectRevert(bytes("local only"));
        vm.prank(PAYER);
        meter.settleConfidential(PAYER, hex"1234", RECEIPT);
        assertFalse(meter.settled(RECEIPT));
        assertEq(usdc.balanceOf(PAYER), 1_000_000);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function testAlternateLocalChainRetainsExplicitMockHook() public {
        meter.setConfidential(address(new MockConfidentialTransfer()));
        vm.chainId(1337);
        vm.prank(PAYER);
        meter.settleConfidential(PAYER, hex"1234", RECEIPT);
        assertTrue(meter.settled(RECEIPT));
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function testFuzzVaultSplitDistributesEntireBalanceIncludingDust(uint96 rawAmount) public {
        uint256 amount = uint256(rawAmount) + 1;
        usdc.mint(address(vault), amount);
        vault.setSplit(TREASURY, STAKERS, PROVIDERS, ECOSYSTEM);
        // Distribution may be triggered by anyone, but recipients are owner-controlled.
        vm.prank(ATTACKER);
        vault.distribute();
        assertEq(usdc.balanceOf(TREASURY), amount * 80 / 100);
        assertEq(usdc.balanceOf(STAKERS), amount * 10 / 100);
        assertEq(usdc.balanceOf(PROVIDERS), amount * 5 / 100);
        assertEq(usdc.balanceOf(ECOSYSTEM), amount - amount * 80 / 100 - amount * 10 / 100 - amount * 5 / 100);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function testVaultSplitWithCoincidentRecipientsConservesFunds() public {
        usdc.mint(address(vault), 101);
        vault.setSplit(TREASURY, TREASURY, TREASURY, TREASURY);
        vault.distribute();
        assertEq(usdc.balanceOf(TREASURY), 101);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function testVaultRequiresConfiguredSplitAndPositiveBalance() public {
        vm.expectRevert(bytes("split"));
        vault.distribute();
        vault.setSplit(TREASURY, STAKERS, PROVIDERS, ECOSYSTEM);
        vm.expectRevert(bytes("bal"));
        vault.distribute();
    }

    function testVaultAdministrationRejectsStrangersAndZeroAddresses() public {
        vm.expectRevert(bytes("owner"));
        vm.prank(ATTACKER);
        vault.setSplit(ATTACKER, ATTACKER, ATTACKER, ATTACKER);
        vm.expectRevert(bytes("zero"));
        vault.setSplit(TREASURY, STAKERS, PROVIDERS, address(0));
        vm.expectRevert(bytes("owner"));
        vm.prank(ATTACKER);
        vault.setOwner(ATTACKER);
        vm.expectRevert(bytes("zero"));
        vault.setOwner(address(0));
        vm.expectRevert(bytes("zero"));
        new FeeVault(address(0));
    }

    function testVaultOwnershipTransferRevokesOldOwnerPrivileges() public {
        vault.setOwner(PAYER);
        assertEq(vault.owner(), PAYER);
        vm.expectRevert(bytes("owner"));
        vault.setSplit(TREASURY, STAKERS, PROVIDERS, ECOSYSTEM);
        vm.prank(PAYER);
        vault.setSplit(TREASURY, STAKERS, PROVIDERS, ECOSYSTEM);
        assertEq(vault.treasury(), TREASURY);
    }

    function testBuybackIsOnlyAnIntentAndDoesNotMoveFunds() public {
        usdc.mint(address(vault), 100);
        vm.expectRevert(bytes("amount"));
        vault.queueBuyback(0);
        vault.queueBuyback(50);
        assertEq(usdc.balanceOf(address(vault)), 100);
    }

    function openMandate(uint256 limit) internal {
        vm.prank(PAYER);
        mandate.open(AGENT, limit);
    }

    function spentToday() internal view returns (uint256 spent) {
        (,, spent,) = mandate.mandates(AGENT);
    }

    function testMandateAcceptsExactCapAndRejectsNextUnit() public {
        openMandate(100);
        vm.prank(PAYER);
        mandate.spend(AGENT, 100);
        vm.expectRevert(bytes("mandate"));
        vm.prank(PAYER);
        mandate.spend(AGENT, 1);
        assertEq(spentToday(), 100);
    }

    function testFuzzMandateAggregatesCallsAndRejectsExcess(uint64 rawLimit, uint64 rawFirst) public {
        uint256 limit = uint256(rawLimit) + 1;
        uint256 first = uint256(rawFirst) % limit + 1;
        openMandate(limit);
        vm.prank(PAYER);
        mandate.spend(AGENT, first);
        vm.expectRevert(bytes("mandate"));
        vm.prank(PAYER);
        mandate.spend(AGENT, limit - first + 1);
        assertEq(spentToday(), first);
        if (first < limit) {
            vm.prank(PAYER);
            mandate.spend(AGENT, limit - first);
        }
        assertEq(spentToday(), limit);
    }

    function testMandateResetsAtUtcDayBoundary() public {
        vm.warp(11 days - 1);
        openMandate(100);
        vm.prank(PAYER);
        mandate.spend(AGENT, 100);
        vm.warp(11 days);
        vm.prank(PAYER);
        mandate.spend(AGENT, 1);
        assertEq(spentToday(), 1);
        (,,, uint32 dayKey) = mandate.mandates(AGENT);
        assertEq(dayKey, 11);
        assertEq(mandate.dayKeyNow(), 11);
    }

    function testReopeningMandateDoesNotResetSameDaySpending() public {
        openMandate(100);
        vm.prank(PAYER);
        mandate.spend(AGENT, 90);
        openMandate(100);
        assertEq(spentToday(), 90);
        vm.expectRevert(bytes("mandate"));
        vm.prank(PAYER);
        mandate.spend(AGENT, 11);
    }

    function testLoweringMandateBelowSpentBlocksFurtherCalls() public {
        openMandate(100);
        vm.prank(PAYER);
        mandate.spend(AGENT, 90);
        openMandate(50);
        vm.expectRevert(bytes("mandate"));
        vm.prank(PAYER);
        mandate.spend(AGENT, 1);
        vm.warp(11 days);
        vm.prank(PAYER);
        mandate.spend(AGENT, 50);
        assertEq(spentToday(), 50);
    }

    function testStrangersCannotOverwriteOrConsumeAnotherMandate() public {
        openMandate(100);
        vm.expectRevert(bytes("owner"));
        vm.prank(ATTACKER);
        mandate.open(AGENT, 1_000_000);
        vm.expectRevert(bytes("owner"));
        vm.prank(ATTACKER);
        mandate.spend(AGENT, 1);
        assertEq(spentToday(), 0);
    }

    function testMandateRejectsMissingAgentZeroLimitAndZeroAmount() public {
        vm.expectRevert(bytes("none"));
        mandate.spend(AGENT, 1);
        vm.expectRevert(bytes("limit"));
        mandate.open(AGENT, 0);
        openMandate(100);
        vm.expectRevert(bytes("amount"));
        vm.prank(PAYER);
        mandate.spend(AGENT, 0);
    }
}
