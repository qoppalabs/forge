import { mkdir } from "node:fs/promises";
import path from "node:path";

import { getTransferSolInstruction } from "@solana-program/system";
import { lamports } from "@solana/kit";

import {
  airdrop,
  createMint,
  createRpc,
  createTokenAccount,
  mintTo,
  newWallet,
  send,
  walletFromSeed,
} from "./lib";
import type { Wallet } from "./lib";

export const ROOT = path.join(import.meta.dir, "..", "..", "..");
export const DEMO_DIR = path.join(ROOT, ".local", "demo");

export interface Session {
  rpcUrl: string;
  apiUrl: string;
  institutionId: string;
  apiKey: string;
  otherApiKey: string;
  /** Demonstration wallets: seeds live only in this ignored file and the signer processes. */
  wallets: Record<
    "treasury" | "approverA" | "approverB" | "borrower" | "outsider",
    { address: string; seed: string }
  >;
  accounts: {
    mint: string;
    treasurySource: string;
    treasuryDestination: string;
    borrowerTokens: string;
    outsiderTokens: string;
  };
}

export const FUNDING = 10_000_000_000n;
export const BORROWER_INTEREST_FUNDING = 100_000_000n;
/** SOL each signing role gets from the treasury when the cluster has no airdrop (Devnet). */
const ROLE_LAMPORTS = 50_000_000n;
const TREASURY_MIN_LAMPORTS = 300_000_000n;
const NAMES = [
  "treasury",
  "approverA",
  "approverB",
  "borrower",
  "outsider",
] as const;

/**
 * Wallets kept in `walletsPath` when given, so a Devnet treasury can be funded by hand before
 * the seed runs; otherwise fresh wallets that live only in this run.
 */
async function fixtureWallets(walletsPath?: string) {
  const file = walletsPath ? Bun.file(walletsPath) : undefined;
  const saved: Record<string, string> =
    file && (await file.exists()) ? await file.json() : {};
  const wallets: Record<string, Wallet> = Object.fromEntries(
    await Promise.all(
      NAMES.map(async (name) => {
        const seedHex = saved[name];
        const wallet = seedHex
          ? await walletFromSeed(name, seedHex)
          : await newWallet(name);
        return [name, wallet] as const;
      })
    )
  );
  if (walletsPath) {
    const seeds = Object.fromEntries(
      Object.entries(wallets).map(([name, w]) => [name, w.seedHex])
    );
    await Bun.write(walletsPath, JSON.stringify(seeds, null, 2));
  }
  return wallets;
}

async function createInstitution(
  databaseUrl: string,
  name: string,
  webhookUrl?: string
) {
  const args = [
    process.execPath,
    path.join(ROOT, "apps/api/src/cli.ts"),
    "create-institution",
    "--name",
    name,
  ];
  if (webhookUrl) {
    args.push("--webhook-url", webhookUrl);
  }
  const proc = Bun.spawn(args, {
    env: { ...process.env, FORGE_DATABASE_URL: databaseUrl },
    stderr: "inherit",
    stdout: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`create-institution failed for ${name}`);
  }
  return JSON.parse(output.trim().split("\n").at(-1) ?? "") as {
    institutionId: string;
    apiKey: string;
  };
}

/**
 * Local fixtures: independent demonstration wallets, a six-decimal FORGE_TEST_USD mint whose
 * authority is the fixture treasury (disclosed), 10,000 tokens for funding and 100 tokens of
 * disclosed borrower interest funding. Everything is disposable loopback state.
 */
export async function seed(options: {
  rpcUrl: string;
  apiUrl: string;
  databaseUrl: string;
  webhookUrl?: string;
  /** Persist wallet seeds here and fund the roles from the treasury instead of airdrops. */
  walletsPath?: string;
}): Promise<Session> {
  const rpc = createRpc(options.rpcUrl);
  const wallets = await fixtureWallets(options.walletsPath);
  const { treasury, approverA, approverB, borrower, outsider } = wallets;
  if (!(treasury && approverA && approverB && borrower && outsider)) {
    throw new Error("fixture wallets missing");
  }
  if (options.walletsPath) {
    const { value: balance } = await rpc
      .getBalance(treasury.address, { commitment: "confirmed" })
      .send();
    if (balance < TREASURY_MIN_LAMPORTS) {
      throw new Error(
        `Fund the treasury ${treasury.address} with at least 0.3 SOL (https://faucet.solana.com), then rerun.`
      );
    }
    await send(
      rpc,
      treasury.signer,
      [approverA, approverB, borrower].map((w) =>
        getTransferSolInstruction({
          amount: lamports(ROLE_LAMPORTS),
          destination: w.address,
          source: treasury.signer,
        })
      )
    );
  } else {
    for (const wallet of Object.values(wallets)) {
      // oxlint-disable-next-line no-await-in-loop -- each airdrop is confirmed before the next wallet
      await airdrop(rpc, wallet.address, 10);
    }
  }
  const mint = await createMint(rpc, treasury.signer, treasury.address, 6);
  const treasurySource = await createTokenAccount(
    rpc,
    treasury.signer,
    mint,
    treasury.address
  );
  const treasuryDestination = await createTokenAccount(
    rpc,
    treasury.signer,
    mint,
    treasury.address
  );
  const borrowerTokens = await createTokenAccount(
    rpc,
    treasury.signer,
    mint,
    borrower.address
  );
  const outsiderTokens = await createTokenAccount(
    rpc,
    treasury.signer,
    mint,
    outsider.address
  );
  await mintTo(rpc, treasury.signer, mint, treasurySource, FUNDING);
  await mintTo(
    rpc,
    treasury.signer,
    mint,
    borrowerTokens,
    BORROWER_INTEREST_FUNDING
  );

  const bank = await createInstitution(
    options.databaseUrl,
    "Demo Bank",
    options.webhookUrl
  );
  const other = await createInstitution(options.databaseUrl, "Other Bank");
  return {
    accounts: {
      borrowerTokens,
      mint,
      outsiderTokens,
      treasuryDestination,
      treasurySource,
    },
    apiKey: bank.apiKey,
    apiUrl: options.apiUrl,
    institutionId: bank.institutionId,
    otherApiKey: other.apiKey,
    rpcUrl: options.rpcUrl,
    wallets: Object.fromEntries(
      Object.entries(wallets).map(([name, w]) => [
        name,
        { address: w.address, seed: w.seedHex },
      ])
    ) as unknown as Session["wallets"],
  };
}

export async function writeSession(session: Session, dir = DEMO_DIR) {
  await mkdir(dir, { recursive: true });
  const sessionPath = path.join(dir, "session.json");
  await Bun.write(sessionPath, JSON.stringify(session, null, 2));
  return sessionPath;
}

export type { Address } from "@solana/kit";

if (import.meta.main) {
  const session = await seed({
    apiUrl: process.env.FORGE_API_URL ?? "http://127.0.0.1:3002",
    databaseUrl:
      process.env.FORGE_DATABASE_URL ??
      "postgres://forge@127.0.0.1:54329/forge",
    rpcUrl: process.env.FORGE_RPC_URL ?? "http://127.0.0.1:8899",
    walletsPath: process.env.FORGE_FIXTURE_WALLETS,
  });
  const sessionPath = await writeSession(
    session,
    process.env.FORGE_DEMO_DIR ?? DEMO_DIR
  );
  console.log(
    `seeded demo wallets, mint ${session.accounts.mint} and institutions → ${sessionPath}`
  );
}
