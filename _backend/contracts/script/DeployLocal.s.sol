pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ENCL} from "../src/ENCL.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {UsageMeter} from "../src/UsageMeter.sol";
import {ModelRegistry} from "../src/ModelRegistry.sol";
import {AttestationVerifier} from "../src/AttestationVerifier.sol";
import {AgentMandate} from "../src/AgentMandate.sol";
import {InsuranceStaking} from "../src/InsuranceStaking.sol";

contract DeployLocal is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address signer = vm.envAddress("ENCLAVE_SIGNER");
        vm.startBroadcast(pk);
        MockUSDC usdc = new MockUSDC();
        FeeVault fees = new FeeVault(address(usdc));
        ENCL token = new ENCL(msg.sender, msg.sender, msg.sender, msg.sender, 1_000_000 ether);
        ModelRegistry registry = new ModelRegistry(address(token), 1 ether);
        AttestationVerifier verifier = new AttestationVerifier(address(registry), signer);
        UsageMeter meter = new UsageMeter(address(usdc), address(fees));
        InsuranceStaking staking = new InsuranceStaking(address(token));
        AgentMandate mandates = new AgentMandate();
        vm.stopBroadcast();
        console.log("USDC", address(usdc));
        console.log("FeeVault", address(fees));
        console.log("UsageMeter", address(meter));
        console.log("ModelRegistry", address(registry));
        console.log("AttestationVerifier", address(verifier));
        console.log("ENCL", address(token));
        console.log("InsuranceStaking", address(staking));
        console.log("AgentMandate", address(mandates));
    }
}
