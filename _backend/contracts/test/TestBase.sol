pragma solidity ^0.8.28;

/// @dev Small, vendoring-free test harness; cheatcodes are provided by Forge.
interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function expectRevert(bytes calldata reason) external;
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function warp(uint256 timestamp) external;
    function roll(uint256 blockNumber) external;
    function setBlockhash(uint256 blockNumber, bytes32 blockHash) external;
    function chainId(uint256 id) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

abstract contract Test {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error UintMismatch(uint256 actual, uint256 expected);
    error AddressMismatch(address actual, address expected);
    error Bytes32Mismatch(bytes32 actual, bytes32 expected);

    function assertEq(uint256 actual, uint256 expected) internal pure {
        if (actual != expected) revert UintMismatch(actual, expected);
    }

    function assertEq(address actual, address expected) internal pure {
        if (actual != expected) revert AddressMismatch(actual, expected);
    }

    function assertEq(bytes32 actual, bytes32 expected) internal pure {
        if (actual != expected) revert Bytes32Mismatch(actual, expected);
    }

    function assertTrue(bool value) internal pure { require(value, "expected true"); }
    function assertFalse(bool value) internal pure { require(!value, "expected false"); }
}
