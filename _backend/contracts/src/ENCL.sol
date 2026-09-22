pragma solidity ^0.8.28;

contract ENCL {
    string public constant name = "ENCLAVE";
    string public constant symbol = "ENCL";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @notice 80/10/5/5 genesis split: treasury / team / providers / ecosystem
    constructor(address treasury, address team, address providers, address ecosystem, uint256 supply) {
        require(treasury != address(0) && team != address(0) && providers != address(0) && ecosystem != address(0), "zero");
        totalSupply = supply;
        uint256 t80 = (supply * 80) / 100;
        uint256 t10 = (supply * 10) / 100;
        uint256 t5 = (supply * 5) / 100;
        uint256 remainder = supply - t80 - t10 - t5;
        balanceOf[treasury] += t80;
        balanceOf[team] += t10;
        balanceOf[providers] += t5;
        balanceOf[ecosystem] += remainder;
        emit Transfer(address(0), treasury, t80);
        emit Transfer(address(0), team, t10);
        emit Transfer(address(0), providers, t5);
        emit Transfer(address(0), ecosystem, remainder);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "to");
        require(balanceOf[from] >= value, "balance");
        unchecked {
            balanceOf[from] -= value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
