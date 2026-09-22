pragma solidity ^0.8.28;

interface IArcConfidentialTransfer {
    /// @notice Arc confidential USDC path. Pin ABI from live docs before mainnet.
    function confidentialTransfer(address to, bytes calldata shieldedAmount) external returns (bool);
}
