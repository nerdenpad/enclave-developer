pragma solidity ^0.8.28;

/// @notice Daily USDC mandate for sealed agents. Enforced on-chain (PDF law 4).
contract AgentMandate {
    address public immutable owner = msg.sender;
    address public settlementMeter;
    struct Mandate {
        address owner;
        uint256 dailyLimit;
        uint256 spentToday;
        uint32 dayKey;
    }

    mapping(bytes32 => Mandate) public mandates;
    mapping(bytes32 => bytes32) public spendCommitments;

    event Opened(bytes32 indexed agent, address indexed owner, uint256 dailyLimit);
    event Spent(bytes32 indexed agent, uint256 amount, uint256 spentToday);
    event SettlementMeterSet(address indexed meter);
    event PaymentAuthorized(bytes32 indexed paymentId, bytes32 indexed agent, address indexed payer, uint256 amount);

    function setSettlementMeter(address meter) external {
        require(msg.sender == owner, "owner");
        require(meter != address(0) && meter.code.length > 0, "meter");
        settlementMeter = meter;
        emit SettlementMeterSet(meter);
    }

    function dayKeyNow() public view returns (uint32) {
        return uint32(block.timestamp / 1 days);
    }

    function open(bytes32 agent, uint256 dailyLimit) external {
        require(dailyLimit > 0, "limit");
        Mandate storage row = mandates[agent];
        if (row.owner == address(0)) {
            row.owner = msg.sender;
            row.dayKey = dayKeyNow();
        } else {
            require(row.owner == msg.sender, "owner");
        }
        row.dailyLimit = dailyLimit;
        emit Opened(agent, row.owner, dailyLimit);
    }

    function spend(bytes32 agent, uint256 amount) external {
        _spend(agent, msg.sender, amount);
    }

    /// @notice Called by the approved meter in the same transaction as token settlement.
    function spendFor(bytes32 agent, address payer, uint256 amount, bytes32 paymentId) external {
        require(msg.sender == settlementMeter, "meter");
        require(paymentId != bytes32(0), "payment");
        bytes32 commitment = keccak256(abi.encode(agent, payer, amount));
        bytes32 previous = spendCommitments[paymentId];
        if (previous != bytes32(0)) {
            require(previous == commitment, "payment mismatch");
            return;
        }
        _spend(agent, payer, amount);
        spendCommitments[paymentId] = commitment;
        emit PaymentAuthorized(paymentId, agent, payer, amount);
    }

    function _spend(bytes32 agent, address payer, uint256 amount) internal {
        require(amount > 0, "amount");
        Mandate storage row = mandates[agent];
        require(row.owner != address(0), "none");
        require(row.owner == payer, "owner");
        uint32 day = dayKeyNow();
        if (row.dayKey != day) {
            row.spentToday = 0;
            row.dayKey = day;
        }
        require(row.spentToday + amount <= row.dailyLimit, "mandate");
        row.spentToday += amount;
        emit Spent(agent, amount, row.spentToday);
    }
}
