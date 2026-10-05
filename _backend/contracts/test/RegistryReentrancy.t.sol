pragma solidity ^0.8.28;

import {Test} from "./TestBase.sol";
import {ModelRegistry} from "../src/ModelRegistry.sol";

/// @dev An ABI-compatible stake token whose transferFrom attempts a nested listing.
contract RegistryCallbackToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address private callbackTarget;
    bytes private callbackData;
    bool private inCallback;
    bool public acceptTransfers = true;
    uint256 public callbackAttempts;
    bool public callbackSucceeded;
    bytes public callbackResult;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function configureCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
        allowance[address(this)][target] = type(uint256).max;
    }

    function setAcceptTransfers(bool value) external { acceptTransfers = value; }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        if (callbackData.length > 0 && !inCallback) {
            inCallback = true;
            callbackAttempts += 1;
            (callbackSucceeded, callbackResult) = callbackTarget.call(callbackData);
            inCallback = false;
        }
        return acceptTransfers;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return acceptTransfers;
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract RegistryReentrancyTest is Test {
    address private constant PROVIDER = address(0xb0b);
    bytes32 private constant MODEL = keccak256("callback-model");
    bytes32 private constant CODE = keccak256("callback-code");
    bytes32 private constant POLICY = keccak256("outer-policy");
    bytes32 private constant CALLBACK_POLICY = keccak256("callback-policy");
    uint256 private constant STAKE = 10 ether;
    RegistryCallbackToken private token;
    ModelRegistry private registry;

    function setUp() public {
        vm.warp(100);
        token = new RegistryCallbackToken();
        registry = new ModelRegistry(address(token), STAKE);
        token.mint(PROVIDER, 100 ether);
        token.mint(address(token), STAKE);
        vm.prank(PROVIDER);
        token.approve(address(registry), 100 ether);
    }

    function testListBlocksNestedListDuplicate() public { assertDuplicateBlocked(false, false); }
    function testListBlocksNestedPolicyListDuplicate() public { assertDuplicateBlocked(false, true); }
    function testPolicyListBlocksNestedListDuplicate() public { assertDuplicateBlocked(true, false); }
    function testPolicyListBlocksNestedPolicyListDuplicate() public { assertDuplicateBlocked(true, true); }

    function assertDuplicateBlocked(bool outerPolicy, bool nestedPolicy) private {
        bytes memory data = nestedPolicy
            ? abi.encodeCall(ModelRegistry.listWithPolicy, (MODEL, CODE, uint16(700), CALLBACK_POLICY, uint64(9)))
            : abi.encodeCall(ModelRegistry.list, (MODEL, CODE, uint16(700)));
        token.configureCallback(address(registry), data);
        vm.prank(PROVIDER);
        uint256 id = outerPolicy
            ? registry.listWithPolicy(MODEL, CODE, 200, POLICY, 7)
            : registry.list(MODEL, CODE, 200);

        assertEq(token.callbackAttempts(), 1);
        assertFalse(token.callbackSucceeded());
        assertEq(keccak256(token.callbackResult()), keccak256(abi.encodeWithSignature("Error(string)", "reentrant")));
        assertEq(id, 1);
        assertEq(registry.listingCount(), 1);
        assertEq(registry.idByHashes(MODEL, CODE), id);
        (bytes32 model, bytes32 code, address provider,, uint16 bps, uint256 stake,,) = registry.listings(id);
        assertEq(model, MODEL);
        assertEq(code, CODE);
        assertEq(provider, PROVIDER);
        assertEq(bps, 200);
        assertEq(stake, STAKE);
        (bytes32 policyHash, uint64 policyVersion) = registry.listingPolicy(id);
        assertEq(policyHash, outerPolicy ? POLICY : bytes32(0));
        assertEq(policyVersion, outerPolicy ? 7 : 0);
        assertEq(token.balanceOf(PROVIDER), 90 ether);
        assertEq(token.balanceOf(address(registry)), STAKE);
        assertEq(token.balanceOf(address(token)), STAKE);
        assertEq(token.allowance(PROVIDER, address(registry)), 90 ether);
    }

    function testListingGuardResetsAfterSuccess() public {
        vm.prank(PROVIDER);
        registry.list(MODEL, CODE, 200);
        vm.prank(PROVIDER);
        uint256 id = registry.listWithPolicy(keccak256("second-model"), CODE, 300, POLICY, 7);
        assertEq(id, 2);
        assertEq(registry.listingCount(), 2);
        assertEq(token.balanceOf(address(registry)), 2 * STAKE);
    }

    function testRejectedStakeRollsBackAndResetsListingGuard() public {
        token.setAcceptTransfers(false);
        vm.expectRevert(bytes("stake"));
        vm.prank(PROVIDER);
        registry.list(MODEL, CODE, 200);
        assertEq(registry.listingCount(), 0);
        assertEq(registry.idByHashes(MODEL, CODE), 0);
        assertEq(token.balanceOf(PROVIDER), 100 ether);
        assertEq(token.balanceOf(address(registry)), 0);
        assertEq(token.allowance(PROVIDER, address(registry)), 100 ether);

        token.setAcceptTransfers(true);
        vm.prank(PROVIDER);
        uint256 id = registry.listWithPolicy(MODEL, CODE, 200, POLICY, 7);
        assertEq(id, 1);
        assertEq(registry.idByHashes(MODEL, CODE), id);
        assertEq(token.balanceOf(address(registry)), STAKE);
    }
}
