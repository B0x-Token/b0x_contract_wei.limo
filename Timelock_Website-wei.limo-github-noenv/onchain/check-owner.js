// Read-only check: who does the deployed contract think its owner is?
// Needs only RPC_URL and CONTRACT_ADDRESS from .env - no PRIVATE_KEY, no signing.
import "dotenv/config";
import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

if (!RPC_URL || !CONTRACT_ADDRESS) {
    console.error("Missing RPC_URL or CONTRACT_ADDRESS in .env");
    process.exit(1);
}

const ABI = ["function owner() external view returns (address)"];

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const site = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
    const owner = await site.owner();
    console.log("Contract owner():", owner);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
