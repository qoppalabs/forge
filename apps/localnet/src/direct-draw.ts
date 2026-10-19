import path from "node:path";

import {
  compileIntentTransaction,
  decodeTransactionError,
  encodeWireTransaction,
  signPlanTransaction,
} from "@forge/sdk";
import type { ForgeIntent } from "@forge/sdk";

import { createRpc, waitForSignature, walletFromSeed } from "./lib";
import { DEMO_DIR } from "./seed";
import type { Session } from "./seed";

/**
 * Demonstration of program enforcement: the borrower draws the session's newest loan by calling
 * the program directly, around the API. Before both approvals the program rejects it; the failed
 * transaction still lands, so it can be shown in an explorer. Prints {signature, error}.
 */
const dir = process.env.FORGE_DEMO_DIR ?? DEMO_DIR;
const session = (await Bun.file(
  path.join(dir, "session.json")
).json()) as Session;
const get = async (route: string) => {
  const response = await fetch(`${session.apiUrl}${route}`, {
    headers: { authorization: `Bearer ${session.apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`${route}: ${response.status}`);
  }
  return response.json();
};

const [vault] = await get("/v1/vaults");
const loans = await get(`/v1/vaults/${vault.address}/loans`);
const loan = loans.at(-1);
const borrower = await walletFromSeed(
  "borrower",
  session.wallets.borrower.seed
);
const intent: ForgeIntent = {
  borrower: borrower.address,
  destination: session.accounts.borrowerTokens,
  kind: "draw_loan",
  loan: loan.address,
  mint: session.accounts.mint,
  vault: vault.address,
  vaultTokenAccount: vault.token_account,
};

const rpc = createRpc(session.rpcUrl);
const { value } = await rpc
  .getLatestBlockhash({ commitment: "confirmed" })
  .send();
const signed = await signPlanTransaction(
  encodeWireTransaction(compileIntentTransaction(intent, value)),
  [borrower.keyPair]
);
const signature = await rpc
  .sendTransaction(signed as never, { encoding: "base64", skipPreflight: true })
  .send();
const { err } = await waitForSignature(rpc, signature);
console.log(
  JSON.stringify({
    error: err ? decodeTransactionError(err, ["draw_loan"]) : null,
    signature,
  })
);
