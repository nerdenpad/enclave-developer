pragma solidity ^0.8.28;

import {Test} from "./TestBase.sol";
import {ENCL} from "../src/ENCL.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {InsuranceStaking} from "../src/InsuranceStaking.sol";
import {FeeVault, IBuybackRouter} from "../src/FeeVault.sol";

contract TestBuybackRouter is IBuybackRouter {
    uint256 public output;
    bool public consume = true;
    function configure(uint256 amountOut, bool consumeInput) external { output = amountOut; consume = consumeInput; }
    function swapExactInput(address tokenIn, address tokenOut, uint256 amountIn, uint256, address recipient, uint256) external returns (uint256) {
        if (consume) MockUSDC(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        MockUSDC(tokenOut).transfer(recipient, output);
        return type(uint256).max; // Caller must measure actual output, not trust the return value.
    }
}

contract RewardsAndBuybacksTest is Test {
    address private constant ALICE = address(0xa11ce);
    address private constant BOB = address(0xb0b);
    address private constant TREASURY = address(0xfee);
    MockUSDC private usdc;
    ENCL private encl;
    InsuranceStaking private staking;
    FeeVault private vault;
    TestBuybackRouter private router;

    function setUp() public {
        vm.warp(100);
        usdc = new MockUSDC();
        encl = new ENCL(ALICE, BOB, ALICE, BOB, 1_000_000 ether);
        staking = new InsuranceStaking(address(encl));
        staking.configureRewards(address(usdc));
        vault = new FeeVault(address(usdc));
        vault.setSplit(TREASURY, address(staking), TREASURY, TREASURY);
        router = new TestBuybackRouter();
        vault.configureBuyback(address(router), address(encl), TREASURY);
        vm.prank(ALICE);
        encl.transfer(address(router), 1000 ether);
        vm.prank(ALICE);
        encl.approve(address(staking), type(uint256).max);
        vm.prank(BOB);
        encl.approve(address(staking), type(uint256).max);
    }

    function deposit(address who, uint256 amount) private { vm.prank(who); staking.stake(amount); }

    function testRewardsAreProportionalToActualStakeAndClaimedOnce() public {
        deposit(ALICE, 100 ether);
        deposit(BOB, 300 ether);
        usdc.mint(address(staking), 1000);
        staking.syncRewards();
        staking.syncRewards(); // A second sync cannot accrue the same transfer again.
        assertEq(staking.pendingRewards(ALICE), 250);
        assertEq(staking.pendingRewards(BOB), 750);
        vm.prank(ALICE);
        assertEq(staking.claimRewards(), 250);
        vm.prank(BOB);
        assertEq(staking.claimRewards(), 750);
        assertEq(usdc.balanceOf(address(staking)), 0);
        vm.expectRevert(bytes("rewards"));
        vm.prank(ALICE);
        staking.claimRewards();
    }

    function testLateStakeCannotStealAlreadyReceivedFees() public {
        deposit(ALICE, 100 ether);
        usdc.mint(address(staking), 1000);
        deposit(BOB, 100 ether);
        assertEq(staking.pendingRewards(ALICE), 1000);
        assertEq(staking.pendingRewards(BOB), 0);
        usdc.mint(address(staking), 600);
        assertEq(staking.pendingRewards(ALICE), 1300);
        assertEq(staking.pendingRewards(BOB), 300);
    }

    function testUnstakeKeepsEarnedRewardsButStopsFutureAccrual() public {
        deposit(ALICE, 100 ether);
        deposit(BOB, 100 ether);
        usdc.mint(address(staking), 1000);
        vm.prank(ALICE);
        staking.unstake(100 ether);
        usdc.mint(address(staking), 600);
        assertEq(staking.pendingRewards(ALICE), 500);
        assertEq(staking.pendingRewards(BOB), 1100);
        vm.prank(ALICE);
        staking.claimRewards();
        assertEq(usdc.balanceOf(ALICE), 500);
        assertEq(staking.totalStaked(), 100 ether);
    }

    function testFeesWithoutStakersAreQuarantinedAndNotGivenToFirstDepositor() public {
        usdc.mint(address(staking), 1000);
        deposit(ALICE, 100 ether);
        assertEq(staking.unallocatedRewards(), 1000);
        assertEq(staking.pendingRewards(ALICE), 0);
        usdc.mint(address(staking), 200);
        staking.recoverUnallocated(TREASURY, 1000);
        assertEq(usdc.balanceOf(TREASURY), 1000);
        assertEq(staking.pendingRewards(ALICE), 200);
        vm.expectRevert(bytes("unallocated"));
        staking.recoverUnallocated(TREASURY, 1);
    }

    function testVaultDistributionFundsClaimableStakerRewards() public {
        deposit(ALICE, 100 ether);
        usdc.mint(address(vault), 10_000);
        vault.distribute();
        assertEq(staking.pendingRewards(ALICE), 1000);
        vm.prank(ALICE);
        staking.claimRewards();
        assertEq(usdc.balanceOf(ALICE), 1000);
    }

    function testRewardConfigurationAndRecoveryAreOwnerControlled() public {
        vm.expectRevert(bytes("configured"));
        staking.configureRewards(address(usdc));
        vm.expectRevert(bytes("owner"));
        vm.prank(ALICE);
        staking.configureRewards(address(usdc));
        vm.expectRevert(bytes("owner"));
        vm.prank(ALICE);
        staking.recoverUnallocated(ALICE, 1);
        InsuranceStaking fresh = new InsuranceStaking(address(encl));
        vm.expectRevert(bytes("reward token"));
        fresh.configureRewards(address(encl));
        vm.expectRevert(bytes("no rewards"));
        fresh.claimRewards();
    }

    function testFuzzRewardClaimsNeverExceedMeasuredDeposits(uint64 rawReward, uint64 rawAlice, uint64 rawBob) public {
        uint256 aliceStake = uint256(rawAlice) % 1_000_000 + 1;
        uint256 bobStake = uint256(rawBob) % 1_000_000 + 1;
        uint256 reward = uint256(rawReward) + 2_000_002;
        deposit(ALICE, aliceStake);
        deposit(BOB, bobStake);
        usdc.mint(address(staking), reward);
        vm.prank(ALICE);
        uint256 a = staking.claimRewards();
        vm.prank(BOB);
        uint256 b = staking.claimRewards();
        assertTrue(a + b <= reward);
        assertTrue(reward - a - b <= 2);
        assertEq(usdc.balanceOf(address(staking)), reward - a - b);
    }

    function reserve() private {
        vault.setBuybackReserveBps(1000);
        usdc.mint(address(vault), 10_000);
        vault.distribute();
    }

    function testBuybackReserveIsOnlyTenPercentOfTreasuryAndNeverRedistributed() public {
        reserve();
        assertEq(vault.reservedBuyback(), 800);
        assertEq(usdc.balanceOf(address(vault)), 800);
        assertEq(usdc.balanceOf(address(staking)), 1000);
        assertEq(usdc.balanceOf(TREASURY), 8200); // Net treasury + provider + ecosystem.
        vm.expectRevert(bytes("bal"));
        vault.distribute();
        usdc.mint(address(vault), 1000);
        vault.distribute();
        assertEq(vault.reservedBuyback(), 880);
        assertEq(usdc.balanceOf(address(vault)), 880);
    }

    function testBuybackUsesConfiguredRouterAndMeasuredOutputAndClearsAllowance() public {
        reserve();
        router.configure(2 ether, true);
        uint256 supply = encl.balanceOf(TREASURY);
        assertEq(vault.executeBuyback(500, 1 ether, block.timestamp + 1), 2 ether);
        assertEq(vault.reservedBuyback(), 300);
        assertEq(usdc.balanceOf(address(router)), 500);
        assertEq(encl.balanceOf(TREASURY) - supply, 2 ether);
        assertEq(usdc.allowance(address(vault), address(router)), 0);
    }

    function testBuybackCannotConsumeUndistributedFeesBeyondReserve() public {
        reserve();
        usdc.mint(address(vault), 10_000);
        vm.expectRevert(bytes("amount"));
        vault.executeBuyback(801, 1, block.timestamp);
        assertEq(usdc.balanceOf(address(vault)), 10_800);
        assertEq(vault.reservedBuyback(), 800);
    }

    function testBuybackSlippageFailureRollsBackInputReserveAndOutput() public {
        reserve();
        router.configure(1 ether, true);
        vm.expectRevert(bytes("slippage"));
        vault.executeBuyback(500, 2 ether, block.timestamp);
        assertEq(vault.reservedBuyback(), 800);
        assertEq(usdc.balanceOf(address(vault)), 800);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(encl.balanceOf(TREASURY), 0);
        assertEq(usdc.allowance(address(vault), address(router)), 0);
    }

    function testLyingRouterCannotClaimExecutionWithoutSpendingInput() public {
        reserve();
        router.configure(1 ether, false);
        vm.expectRevert(bytes("input spent"));
        vault.executeBuyback(500, 1 ether, block.timestamp);
        assertEq(vault.reservedBuyback(), 800);
    }

    function testBuybackRequiresOwnerNonzeroProtectionAndLiveDeadline() public {
        reserve();
        vm.expectRevert(bytes("owner"));
        vm.prank(ALICE);
        vault.executeBuyback(500, 1, block.timestamp);
        vm.expectRevert(bytes("amount"));
        vault.executeBuyback(500, 0, block.timestamp);
        vm.expectRevert(bytes("deadline"));
        vault.executeBuyback(500, 1, block.timestamp - 1);
        vm.expectRevert(bytes("bps"));
        vault.setBuybackReserveBps(1001);
        vm.expectRevert(bytes("owner"));
        vm.prank(ALICE);
        vault.setBuybackReserveBps(1);
    }
}
