pragma solidity ^0.8.28;

import {ENCL} from "./ENCL.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @notice E3 junior tranche. Draw order (enforced off-chain + later vault hook): buffer → staked ENCL → never holder backing.
contract InsuranceStaking {
    ENCL public immutable token;
    address public immutable owner = msg.sender;
    MockUSDC public rewardToken;
    mapping(address => uint256) public staked;
    uint256 public totalStaked;
    uint256 public rewardPerTokenStored;
    uint256 public accountedRewards;
    uint256 public unallocatedRewards;
    uint256 private constant PRECISION = 1e36;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;
    bool private entered;

    event Staked(address indexed who, uint256 amount);
    event Unstaked(address indexed who, uint256 amount);
    event RewardsConfigured(address indexed token);
    event RewardsAccrued(uint256 amount, uint256 totalStaked);
    event RewardsClaimed(address indexed who, uint256 amount);

    modifier nonReentrant() {
        require(!entered, "reentrant");
        entered = true;
        _;
        entered = false;
    }

    constructor(address token_) {
        require(token_ != address(0), "zero");
        token = ENCL(token_);
    }

    function configureRewards(address usdc) external {
        require(msg.sender == owner, "owner");
        require(address(rewardToken) == address(0), "configured");
        require(usdc != address(0) && usdc != address(token) && usdc.code.length > 0, "reward token");
        rewardToken = MockUSDC(usdc);
        emit RewardsConfigured(usdc);
    }

    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "amount");
        _checkpoint(msg.sender);
        require(token.transferFrom(msg.sender, address(this), amount), "transfer");
        staked[msg.sender] += amount;
        totalStaked += amount;
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant {
        require(amount > 0, "amount");
        require(staked[msg.sender] >= amount, "staked");
        _checkpoint(msg.sender);
        staked[msg.sender] -= amount;
        totalStaked -= amount;
        require(token.transfer(msg.sender, amount), "transfer");
        emit Unstaked(msg.sender, amount);
    }

    function syncRewards() external nonReentrant { _syncRewards(); }

    function pendingRewards(address who) external view returns (uint256) {
        uint256 accumulated = rewardPerTokenStored;
        if (address(rewardToken) != address(0) && totalStaked > 0) {
            uint256 balance = rewardToken.balanceOf(address(this));
            if (balance > accountedRewards) accumulated += ((balance - accountedRewards) * PRECISION) / totalStaked;
        }
        return rewards[who] + (staked[who] * (accumulated - userRewardPerTokenPaid[who])) / PRECISION;
    }

    function claimRewards() external nonReentrant returns (uint256 amount) {
        require(address(rewardToken) != address(0), "no rewards");
        _checkpoint(msg.sender);
        amount = rewards[msg.sender];
        require(amount > 0, "rewards");
        rewards[msg.sender] = 0;
        accountedRewards -= amount;
        require(rewardToken.transfer(msg.sender, amount), "reward transfer");
        emit RewardsClaimed(msg.sender, amount);
    }

    /// @notice Rewards received with no stake belong to no depositor and can be returned to the fee treasury.
    function recoverUnallocated(address to, uint256 amount) external nonReentrant {
        require(msg.sender == owner, "owner");
        require(to != address(0) && amount > 0, "amount");
        _syncRewards();
        require(amount <= unallocatedRewards, "unallocated");
        unallocatedRewards -= amount;
        accountedRewards -= amount;
        require(rewardToken.transfer(to, amount), "reward transfer");
    }

    function _checkpoint(address who) internal {
        _syncRewards();
        rewards[who] += (staked[who] * (rewardPerTokenStored - userRewardPerTokenPaid[who])) / PRECISION;
        userRewardPerTokenPaid[who] = rewardPerTokenStored;
    }

    function _syncRewards() internal {
        if (address(rewardToken) == address(0)) return;
        uint256 balance = rewardToken.balanceOf(address(this));
        require(balance >= accountedRewards, "reward balance");
        uint256 received = balance - accountedRewards;
        if (received == 0) return;
        accountedRewards = balance;
        if (totalStaked == 0) unallocatedRewards += received;
        else rewardPerTokenStored += (received * PRECISION) / totalStaked;
        emit RewardsAccrued(received, totalStaked);
    }
}
