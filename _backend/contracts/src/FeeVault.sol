pragma solidity ^0.8.28;

import {MockUSDC} from "./MockUSDC.sol";

interface IBuybackRouter {
    function swapExactInput(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient, uint256 deadline)
        external returns (uint256 amountOut);
}

contract FeeVault {
    address public owner;
    address public usdc;
    address public treasury;
    address public stakers;
    address public providers;
    address public ecosystem;
    address public buybackRouter;
    address public buybackToken;
    address public buybackRecipient;
    uint16 public buybackReserveBps;
    uint256 public reservedBuyback;
    bool private entered;

    event FeeTaken(address indexed from, uint256 amount, bytes32 indexed receiptHash);
    event SplitSet(address treasury, address stakers, address providers, address ecosystem);
    event Distributed(uint256 treasuryAmt, uint256 stakersAmt, uint256 providersAmt, uint256 ecosystemAmt);
    event BuybackQueued(address indexed caller, uint256 usdcAmount, uint64 queuedAt);
    event BuybackConfigured(address indexed router, address indexed tokenOut, address indexed recipient);
    event BuybackReserved(uint256 amount);
    event BuybackExecuted(address indexed router, uint256 amountIn, uint256 amountOut, address indexed recipient);

    modifier nonReentrant() {
        require(!entered, "reentrant");
        entered = true;
        _;
        entered = false;
    }

    constructor(address usdc_) {
        require(usdc_ != address(0), "zero");
        owner = msg.sender;
        usdc = usdc_;
    }

    function setOwner(address next) external {
        require(msg.sender == owner, "owner");
        require(next != address(0), "zero");
        owner = next;
    }

    function setSplit(address treasury_, address stakers_, address providers_, address ecosystem_) external {
        require(msg.sender == owner, "owner");
        require(treasury_ != address(0) && stakers_ != address(0) && providers_ != address(0) && ecosystem_ != address(0), "zero");
        treasury = treasury_;
        stakers = stakers_;
        providers = providers_;
        ecosystem = ecosystem_;
        emit SplitSet(treasury_, stakers_, providers_, ecosystem_);
    }

    /// @notice 80/10/5/5 of current USDC balance → treasury / stakers / providers / ecosystem.
    function distribute() external nonReentrant returns (uint256 treasuryAmt, uint256 stakersAmt, uint256 providersAmt, uint256 ecosystemAmt) {
        require(treasury != address(0), "split");
        uint256 bal = MockUSDC(usdc).balanceOf(address(this)) - reservedBuyback;
        require(bal > 0, "bal");
        treasuryAmt = (bal * 80) / 100;
        stakersAmt = (bal * 10) / 100;
        providersAmt = (bal * 5) / 100;
        ecosystemAmt = bal - treasuryAmt - stakersAmt - providersAmt;
        uint256 reserve = (treasuryAmt * buybackReserveBps) / 10_000;
        treasuryAmt -= reserve;
        reservedBuyback += reserve;
        if (reserve > 0) emit BuybackReserved(reserve);
        require(MockUSDC(usdc).transfer(treasury, treasuryAmt), "t");
        require(MockUSDC(usdc).transfer(stakers, stakersAmt), "s");
        require(MockUSDC(usdc).transfer(providers, providersAmt), "p");
        require(MockUSDC(usdc).transfer(ecosystem, ecosystemAmt), "e");
        emit Distributed(treasuryAmt, stakersAmt, providersAmt, ecosystemAmt);
    }

    /// @notice Stub: records a buyback intent. No DEX swap until Arc routing is pinned.
    function queueBuyback(uint256 usdcAmount) external {
        require(usdcAmount > 0, "amount");
        emit BuybackQueued(msg.sender, usdcAmount, uint64(block.timestamp));
    }

    function configureBuyback(address router, address tokenOut, address recipient) external {
        require(msg.sender == owner, "owner");
        require(router.code.length > 0 && tokenOut.code.length > 0 && tokenOut != usdc && recipient != address(0), "buyback config");
        buybackRouter = router;
        buybackToken = tokenOut;
        buybackRecipient = recipient;
        emit BuybackConfigured(router, tokenOut, recipient);
    }

    /// @param treasuryBps Percentage of the 80% treasury share, capped at 10% (8% of total fees).
    function setBuybackReserveBps(uint16 treasuryBps) external {
        require(msg.sender == owner, "owner");
        require(treasuryBps <= 1000, "bps");
        buybackReserveBps = treasuryBps;
    }

    function executeBuyback(uint256 amountIn, uint256 minOut, uint256 deadline) external nonReentrant returns (uint256 amountOut) {
        require(msg.sender == owner, "owner");
        require(buybackRouter != address(0), "no router");
        require(amountIn > 0 && minOut > 0 && amountIn <= reservedBuyback, "amount");
        require(block.timestamp <= deadline, "deadline");
        MockUSDC input = MockUSDC(usdc);
        MockUSDC output = MockUSDC(buybackToken);
        uint256 inputBefore = input.balanceOf(address(this));
        uint256 outputBefore = output.balanceOf(buybackRecipient);
        reservedBuyback -= amountIn;
        require(input.approve(buybackRouter, 0), "approve");
        require(input.approve(buybackRouter, amountIn), "approve");
        IBuybackRouter(buybackRouter).swapExactInput(usdc, buybackToken, amountIn, minOut, buybackRecipient, deadline);
        require(input.approve(buybackRouter, 0), "approve");
        require(inputBefore - input.balanceOf(address(this)) == amountIn, "input spent");
        amountOut = output.balanceOf(buybackRecipient) - outputBefore;
        require(amountOut >= minOut, "slippage");
        emit BuybackExecuted(buybackRouter, amountIn, amountOut, buybackRecipient);
    }
}
