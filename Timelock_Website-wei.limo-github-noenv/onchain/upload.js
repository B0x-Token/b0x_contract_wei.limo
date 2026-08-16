// Populates a deployed Site contract with the site's files, one chunk per
// transaction. Resumable and safe to interrupt at any point: progress is
// always re-derived from on-chain state (fileChunkCount), never trusted
// from local memory, and writes are idempotent (setChunk overwrites if that
// index already landed) - so a crash, Ctrl+C, or a resend after an unclear
// failure can never duplicate or corrupt a file. Just run it again.
//
// Required environment variables:
//   RPC_URL           - your Ethereum RPC endpoint
//   PRIVATE_KEY        - the deployer/owner wallet's private key
//   CONTRACT_ADDRESS   - the deployed Site contract's address
//
// Optional:
//   MAX_GWEI          - if the network's current gas price exceeds this,
//                        the script PAUSES and polls every 45s until it
//                        drops back below the cap, then continues - it does
//                        not abort and does not lose progress. Checked
//                        before every single transaction. Defaults to 1.
//
// Usage:
//   cd onchain
//   npm install
//   node upload.js   (reads RPC_URL / PRIVATE_KEY / CONTRACT_ADDRESS from .env)

import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, "..");

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

if (!RPC_URL || !PRIVATE_KEY || !CONTRACT_ADDRESS) {
    console.error("Missing RPC_URL, PRIVATE_KEY, or CONTRACT_ADDRESS environment variable.");
    process.exit(1);
}

const ABI = [
    "function setChunk(string path, uint256 index, string data) external",
    "function fileChunkCount(string path) external view returns (uint256)",
];

// Conservative chunk size: keeps each write comfortably under a fraction of
// the block gas limit instead of racing it.
const CHUNK_SIZE = 5000;

const MAX_GWEI = process.env.MAX_GWEI ? Number(process.env.MAX_GWEI) : 1;
const POLL_INTERVAL_MS = 45_000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Blocks until gas is at or below the cap. Never throws, never aborts the
// run - just waits, so an unattended run survives a temporary spike.
async function waitForGasBelowCap(provider) {
    while (true) {
        const feeData = await provider.getFeeData();
        const gasPriceWei = feeData.gasPrice ?? 0n;
        const gasPriceGwei = Number(gasPriceWei) / 1e9;
        if (gasPriceGwei <= MAX_GWEI) {
            return gasPriceGwei;
        }
        console.log(
            `  gas ${gasPriceGwei.toFixed(4)} gwei > cap ${MAX_GWEI} gwei - ` +
            `waiting ${POLL_INTERVAL_MS / 1000}s before rechecking...`
        );
        await sleep(POLL_INTERVAL_MS);
    }
}

function listFiles() {
    const jsDir = path.join(SITE_ROOT, "js");
    const jsFiles = fs.readdirSync(jsDir)
        .filter((f) => f.endsWith(".js"))
        .map((f) => `js/${f}`);
    return ["index.html", "style.css", ...jsFiles];
}

function chunkString(content, size) {
    const chunks = [];
    for (let i = 0; i < content.length; i += size) {
        chunks.push(content.slice(i, i + size));
    }
    return chunks.length ? chunks : [""];
}

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const site = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

    const files = listFiles();
    console.log(`Uploading ${files.length} files to ${CONTRACT_ADDRESS}`);
    console.log(`Gas price cap: ${MAX_GWEI} gwei (set MAX_GWEI to change)\n`);

    for (const relPath of files) {
        const fullPath = path.join(SITE_ROOT, relPath);
        const content = fs.readFileSync(fullPath, "utf8");
        const chunks = chunkString(content, CHUNK_SIZE);

        // Always re-derived from chain, never from local state - this is
        // what makes resuming after any kind of interruption safe.
        const already = Number(await site.fileChunkCount(relPath));
        if (already >= chunks.length) {
            console.log(`${relPath}: already fully uploaded (${already} chunks) - skipping`);
            continue;
        }

        console.log(`${relPath}: ${chunks.length} chunks total, ${already} already on-chain`);
        // Start one index before "already" too, when already > 0: the last
        // recorded chunk might have landed right as a previous run died
        // mid-confirmation-check, so it's cheap insurance to reconfirm it.
        // setChunk is idempotent, so replaying it is a harmless no-op.
        const start = already > 0 ? already - 1 : 0;
        for (let i = start; i < chunks.length; i++) {
            const gwei = await waitForGasBelowCap(provider);
            const tx = await site.setChunk(relPath, i, chunks[i]);
            console.log(`  chunk ${i + 1}/${chunks.length} -> ${tx.hash} (${gwei.toFixed(4)} gwei)`);
            await tx.wait();
        }
    }

    console.log("\nDone. All files uploaded.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
