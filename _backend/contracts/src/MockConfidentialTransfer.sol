pragma solidity ^0.8.28;

import {IArcConfidentialTransfer} from "./interfaces/IArcConfidentialTransfer.sol";

/// @notice Local stand-in until Arc confidential-transfer precompiles are pinned.
contract MockConfidentialTransfer is IArcConfidentialTransfer {
    event Shielded(address indexed to, uint256 blobLength);

    function confidentialTransfer(address to, bytes calldata shieldedAmount) external returns (bool) {
        emit Shielded(to, shieldedAmount.length);
        return true;
    }
}
