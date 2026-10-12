// The bank-core example against the real worker: FORGE-signed deliveries are accepted, a
// redelivery is applied once, and each event reconciles the vault statement over REST.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createReceiver,
  verifySignature,
} from "../../../examples/bank-core/receiver";
import { setup } from "./harness";
import type { Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h.close();
});

test("the bank-core receiver verifies, deduplicates and reconciles FORGE webhooks", async () => {
  const ledger = path.join(
    await mkdtemp(path.join(tmpdir(), "bank-core-")),
    "applied.jsonl"
  );
  const lines: string[] = [];
  const receiver = Bun.serve({
    fetch: createReceiver({
      apiKey: h.bank.apiKey,
      apiUrl: `http://127.0.0.1:${h.server.port}`,
      ledger,
      log: (line) => lines.push(line),
      secret: h.bank.institution.webhook_secret as string,
    }),
    port: 0,
  });
  await h.db`UPDATE institutions SET webhook_url = ${`http://127.0.0.1:${receiver.port}/hook`} WHERE id = ${h.bank.institution.id}`;
  await h.createVault();
  const worker = h.worker();
  await worker.webhooks.deliver();
  // Redeliver the same event, as a crashed or slow worker would.
  await h.db`UPDATE webhook_outbox SET delivered_at = NULL, next_attempt_at = now()`;
  await worker.webhooks.deliver();
  receiver.stop(true);

  const [row] = await h.db`SELECT delivered_at, attempts FROM webhook_outbox`;
  expect(row.delivered_at).not.toBeNull();
  expect(row.attempts).toBe(2);
  const text = await readFile(ledger, "utf-8");
  const applied = text.trim().split("\n");
  expect(applied).toHaveLength(1);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("vault.created");
  expect(lines[0]).toContain("balanced=true");
});

test("signatures must match the body and be fresh", async () => {
  const secret = "whsec_test";
  const sign = async (t: number, body: string) => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${t}.${body}`)
    );
    return `t=${t},v1=${Buffer.from(mac).toString("hex")}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const header = await sign(now, "{}");
  expect(await verifySignature(secret, header, "{}")).toBe(true);
  expect(await verifySignature(secret, header, "{ }")).toBe(false);
  expect(await verifySignature("whsec_other", header, "{}")).toBe(false);
  expect(await verifySignature(secret, await sign(now - 600, "{}"), "{}")).toBe(
    false
  );
  expect(await verifySignature(secret, null, "{}")).toBe(false);
});
