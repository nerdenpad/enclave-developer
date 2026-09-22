pragma solidity ^0.8.28;

import {Test, Vm} from "./TestBase.sol";
import {ENCL} from "../src/ENCL.sol";
import {InsuranceStaking} from "../src/InsuranceStaking.sol";

contract TokenAndStakingTest is Test {
    address internal constant ALICE = address(0xa11ce);
    address internal constant BOB = address(0xb0b);
    address internal constant CAROL = address(0xca401);
    address internal constant DAVE = address(0xda7e);
    ENCL internal token;
    InsuranceStaking internal staking;

    function setUp() public {
        token = new ENCL(ALICE, BOB, CAROL, DAVE, 1_000_000 ether);
        staking = new InsuranceStaking(address(token));
    }

    function testFuzzGenesisConservesSupply(uint96 supply) public {
        ENCL t = new ENCL(ALICE, BOB, CAROL, DAVE, supply);
        assertEq(t.totalSupply(), supply);
        assertEq(t.balanceOf(ALICE), uint256(supply) * 80 / 100);
        assertEq(t.balanceOf(BOB), uint256(supply) * 10 / 100);
        assertEq(t.balanceOf(CAROL), uint256(supply) * 5 / 100);
        assertEq(t.balanceOf(ALICE) + t.balanceOf(BOB) + t.balanceOf(CAROL) + t.balanceOf(DAVE), supply);
    }

    function testFuzzCoincidentGenesisRecipientsKeepEntireSupply(uint96 supply) public {
        ENCL t = new ENCL(ALICE, ALICE, ALICE, ALICE, supply);
        assertEq(t.balanceOf(ALICE), supply);
        assertEq(t.totalSupply(), supply);
    }

    function testPartiallyCoincidentGenesisRecipientsAndMintEvents() public {
        vm.recordLogs();
        ENCL t = new ENCL(ALICE, BOB, ALICE, BOB, 101);
        assertEq(t.balanceOf(ALICE), 85);
        assertEq(t.balanceOf(BOB), 16);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 4);
        uint256 emittedSupply;
        for (uint256 i; i < logs.length; i++) emittedSupply += abi.decode(logs[i].data, (uint256));
        assertEq(emittedSupply, t.totalSupply());
        assertEq(abi.decode(logs[3].data, (uint256)), 6);
    }

    function testGenesisRejectsZeroRecipient() public {
        vm.expectRevert(bytes("zero"));
        new ENCL(ALICE, BOB, CAROL, address(0), 100);
    }

    function testTransferFromConsumesAllowanceAndConservesSupply() public {
        vm.prank(ALICE);
        token.approve(BOB, 30 ether);
        vm.prank(BOB);
        token.transferFrom(ALICE, CAROL, 20 ether);
        assertEq(token.allowance(ALICE, BOB), 10 ether);
        assertEq(token.balanceOf(ALICE), 799_980 ether);
        assertEq(token.balanceOf(CAROL), 50_020 ether);
        assertEq(token.totalSupply(), 1_000_000 ether);
    }

    function testInfiniteAllowanceIsNotConsumed() public {
        vm.prank(ALICE);
        token.approve(BOB, type(uint256).max);
        vm.prank(BOB);
        token.transferFrom(ALICE, CAROL, 10);
        assertEq(token.allowance(ALICE, BOB), type(uint256).max);
    }

    function testTransferWithoutAllowanceFails() public {
        vm.expectRevert(bytes("allowance"));
        vm.prank(BOB);
        token.transferFrom(ALICE, BOB, 1);
    }

    function testInsufficientBalanceDoesNotBurnAllowance() public {
        vm.prank(ALICE);
        token.approve(BOB, 900_000 ether);
        vm.expectRevert(bytes("balance"));
        vm.prank(BOB);
        token.transferFrom(ALICE, BOB, 900_000 ether);
        assertEq(token.allowance(ALICE, BOB), 900_000 ether);
        assertEq(token.balanceOf(ALICE), 800_000 ether);
    }

    function testTransferToZeroRejectedAndSelfTransferConservesBalance() public {
        vm.expectRevert(bytes("to"));
        vm.prank(ALICE);
        token.transfer(address(0), 1);
        vm.prank(ALICE);
        token.transfer(ALICE, 12);
        assertEq(token.balanceOf(ALICE), 800_000 ether);
    }

    function testFuzzStakeAndPartialUnstakePreserveAccounting(uint96 rawAmount) public {
        uint256 amount = uint256(rawAmount) % (800_000 ether) + 1;
        vm.startPrank(ALICE);
        token.approve(address(staking), amount);
        staking.stake(amount);
        assertEq(staking.staked(ALICE), amount);
        assertEq(staking.totalStaked(), amount);
        assertEq(token.balanceOf(address(staking)), amount);
        uint256 withdrawn = amount / 2 + 1;
        staking.unstake(withdrawn);
        assertEq(staking.staked(ALICE), amount - withdrawn);
        assertEq(staking.totalStaked(), amount - withdrawn);
        assertEq(token.balanceOf(address(staking)), amount - withdrawn);
        assertEq(token.balanceOf(ALICE), 800_000 ether - amount + withdrawn);
        vm.stopPrank();
    }

    function testStakeWithoutAllowanceRollsBackAccounting() public {
        vm.expectRevert(bytes("allowance"));
        vm.prank(ALICE);
        staking.stake(1);
        assertEq(staking.totalStaked(), 0);
        assertEq(staking.staked(ALICE), 0);
    }

    function testStakersCannotWithdrawEachOthersFunds() public {
        vm.startPrank(ALICE);
        token.approve(address(staking), 100);
        staking.stake(100);
        vm.stopPrank();
        vm.expectRevert(bytes("staked"));
        vm.prank(BOB);
        staking.unstake(1);
        assertEq(staking.totalStaked(), 100);
        vm.expectRevert(bytes("staked"));
        vm.prank(ALICE);
        staking.unstake(101);
    }

    function testZeroStakeAndUnstakeRejected() public {
        vm.expectRevert(bytes("amount"));
        staking.stake(0);
        vm.expectRevert(bytes("amount"));
        staking.unstake(0);
    }

    function testStakingRejectsZeroToken() public {
        vm.expectRevert(bytes("zero"));
        new InsuranceStaking(address(0));
    }
}
