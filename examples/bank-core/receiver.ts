// A minimal bank-core consumer of FORGE, independent of the SDK: it verifies signed webhooks,
// applies each event id once, and reconciles the vault statement over plain REST.
//
//   FORGE_API_URL=http://127.0.0.1:3002 FORGE_API_KEY=fk_… FORGE_WEBHOOK_SECRET=whsec_… \
//     bun examples/bank-core/receiver.ts
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Signed timestamps older or newer than this are rejected, which bounds replay. */
const TOLERANCE_SECONDS = 300;

export interface ForgeEvent {
  id: string;
  type: string;
  createdAt: string;
  data: { vault?: string };
}

/** `Forge-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` over the raw body. */
export async function verifySignature(
  secret: string,
  header: string | null,
  body: string,
  nowSeconds = Date.now() / 1000
): Promise<boolean> {
  const groups = /^t=(?<t>\d+),v1=(?<mac>[0-9a-f]{64})$/u.exec(
    header ?? ""
  )?.groups;
  if (!groups?.t || !groups.mac) {
    return false;
  }
  if (Math.abs(nowSeconds - Number(groups.t)) > TOLERANCE_SECONDS) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["verify"]
  );
  // subtle.verify compares in constant time.
  return crypto.subtle.verify(
    "HMAC",
    key,
    Buffer.from(groups.mac, "hex"),
    new TextEncoder().encode(`${groups.t}.${body}`)
  );
}

export function createReceiver(options: {
  secret: string;
  apiUrl: string;
  apiKey: string;
  /** Append-only record of applied event ids; survives restarts. */
  ledger: string;
  log?: (line: string) => void;
}) {
  const log = options.log ?? console.log;
  async function load(): Promise<Set<string>> {
    let text = "";
    try {
      text = await readFile(options.ledger, "utf-8");
    } catch {
      // No ledger yet: nothing applied.
    }
    return new Set(
      text
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as ForgeEvent).id)
    );
  }
  let seen: Promise<Set<string>> | undefined;
  const applied = () => {
    seen ??= load();
    return seen;
  };

  async function reconcile(vault: string) {
    const response = await fetch(
      `${options.apiUrl}/v1/vaults/${vault}/statement`,
      { headers: { authorization: `Bearer ${options.apiKey}` } }
    );
    if (!response.ok) {
      throw new Error(`statement ${vault}: HTTP ${response.status}`);
    }
    return (await response.json()) as {
      balanced: boolean;
      postings: unknown[];
      reconciliation: { matches: boolean };
    };
  }

  return async function handle(request: Request): Promise<Response> {
    const body = await request.text();
    const signature = request.headers.get("forge-signature");
    if (!(await verifySignature(options.secret, signature, body))) {
      return new Response("invalid signature", { status: 401 });
    }
    const event = JSON.parse(body) as ForgeEvent;
    const ids = await applied();
    // Delivery is at least once: a repeat is acknowledged so FORGE stops retrying it.
    if (ids.has(event.id)) {
      return new Response("duplicate", { status: 200 });
    }
    if (event.data.vault) {
      try {
        const statement = await reconcile(event.data.vault);
        log(
          `${event.type} ${event.data.vault}: ${statement.postings.length} postings, ` +
            `balanced=${statement.balanced}, matches chain=${statement.reconciliation.matches}`
        );
      } catch (error) {
        // Not recorded as applied, so FORGE redelivers it later.
        log(`${event.type}: ${(error as Error).message}`);
        return new Response("reconciliation failed", { status: 502 });
      }
    }
    ids.add(event.id);
    await mkdir(path.dirname(options.ledger), { recursive: true });
    await appendFile(options.ledger, `${JSON.stringify(event)}\n`);
    return new Response("ok");
  };
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

if (import.meta.main) {
  const server = Bun.serve({
    fetch: createReceiver({
      apiKey: env("FORGE_API_KEY"),
      apiUrl: process.env.FORGE_API_URL ?? "http://127.0.0.1:3002",
      ledger:
        process.env.BANK_CORE_LEDGER ?? ".local/bank-core/applied-events.jsonl",
      secret: env("FORGE_WEBHOOK_SECRET"),
    }),
    hostname: "127.0.0.1",
    port: Number(process.env.PORT ?? 4010),
  });
  console.log(`bank-core receiver on ${server.url}`);
}
