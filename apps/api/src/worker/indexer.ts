import type { Chain, SignatureInfo } from "../chain";
import type { Db } from "../db";
import { enqueueEvent } from "./ledger";
import type { ProcessResult, Reconciler } from "./reconciler";

const PAGE = 500;
/** Failed passes before a signature is quarantined so its vault keeps indexing. */
const QUARANTINE_AFTER = 3;

/**
 * Polling indexer with a persisted cursor per watched address (vault PDA and vault token
 * account). It ingests finalized transactions the API never planned — direct program calls,
 * wallet-broadcast transactions and plain token donations — through the same reconciler.
 * The cursor advances only after a signature's facts are committed; replays are deduplicated
 * by (network, signature), so a crash between the two steps is harmless.
 */
export class Indexer {
  private readonly db: Db;
  private readonly chain: Chain;
  private readonly reconciler: Reconciler;
  private readonly failures = new Map<string, number>();

  constructor(db: Db, chain: Chain, reconciler: Reconciler) {
    this.db = db;
    this.chain = chain;
    this.reconciler = reconciler;
  }

  /**
   * Watches vaults that exist on chain or whose creation can still land; a registration whose
   * create operation provably expired or failed costs nothing until it is re-prepared. A vault
   * that fails to sync is reported but never stops the others.
   */
  async syncAll(): Promise<void> {
    const vaults = await this.db`
      SELECT v.address FROM vaults v
      WHERE v.onchain OR EXISTS (
        SELECT 1 FROM operations o
        WHERE o.vault = v.address AND o.kind = 'create_vault' AND o.status NOT IN ('expired', 'failed'))
      ORDER BY v.created_at`;
    const failures: unknown[] = [];
    for (const vault of vaults) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- vaults sync one at a time so reconciler transactions never race each other
        await this.syncVault(vault.address);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${failures.length} vault(s) failed to sync: ${(failures[0] as Error).message}`
      );
    }
  }

  async syncVault(vault: string): Promise<void> {
    const [row] = await this
      .db`SELECT address, token_account FROM vaults WHERE address = ${vault}`;
    if (!row) {
      return;
    }
    await this.syncAddress(row.address);
    await this.syncAddress(row.token_account);
  }

  private async syncAddress(address: string): Promise<void> {
    const name = `${this.chain.network}:${address}`;
    const [cursor] = await this
      .db`SELECT signature, slot FROM cursors WHERE name = ${name}`;
    let pending: SignatureInfo[];
    try {
      pending = await this.newerThan(address, {
        until: cursor?.signature ?? undefined,
      });
    } catch (error) {
      if (!cursor || !/not found/iu.test((error as Error).message)) {
        throw error;
      }
      // The node pruned the cursor's transaction. Page back by slot instead; anything already
      // processed is deduplicated by (network, signature).
      const floor = BigInt(cursor.slot ?? 0);
      pending = await this.newerThan(address, { floor });
    }
    // Oldest first, so the cursor only ever moves forward over committed work.
    for (const info of pending.toReversed()) {
      let result: ProcessResult;
      try {
        // oxlint-disable-next-line no-await-in-loop -- signatures must be processed oldest-first, one at a time
        result = await this.reconciler.processSignature(info.signature);
      } catch (error) {
        // oxlint-disable-next-line no-await-in-loop -- quarantine decides whether the cursor may move past it
        if (!(await this.quarantine(address, info.signature, error))) {
          throw error;
        }
        result = "processed";
      }
      if (result === "not_found") {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- the cursor advances only after this signature's facts are committed
      await this.db`
        INSERT INTO cursors (name, signature, slot) VALUES (${name}, ${info.signature}, ${info.slot.toString()})
        ON CONFLICT (name) DO UPDATE SET signature = EXCLUDED.signature, slot = EXCLUDED.slot, updated_at = now()`;
    }
  }

  /**
   * A signature that keeps failing (an unsupported transaction version, data that will not decode)
   * becomes an `unprocessable_transaction` exception on its vault and is skipped, so one
   * transaction cannot freeze the vault's indexing. RPC outages fail earlier, while listing
   * signatures. Removing the exception and the vault's cursors re-ingests it.
   * shortcut: counts failed passes, not elapsed time; add a time window if transient per-signature
   * RPC errors ever quarantine a valid transaction.
   */
  private async quarantine(
    address: string,
    signature: string,
    error: unknown
  ): Promise<boolean> {
    const attempts = (this.failures.get(signature) ?? 0) + 1;
    this.failures.set(signature, attempts);
    if (attempts < QUARANTINE_AFTER) {
      return false;
    }
    this.failures.delete(signature);
    const { network } = this.chain;
    await this.db.begin(async (raw) => {
      const sql = raw as Db;
      const [vault] = await sql`
        SELECT address, institution_id FROM vaults WHERE address = ${address} OR token_account = ${address}`;
      if (!vault) {
        return;
      }
      const { message } = error as Error;
      const [exception] = await sql`
        INSERT INTO exceptions (network, vault, kind, signature, details)
        VALUES (${network}, ${vault.address}, 'unprocessable_transaction', ${signature}, ${{ error: message }})
        ON CONFLICT (network, vault, kind, signature) DO NOTHING RETURNING id`;
      if (exception) {
        await enqueueEvent(sql, {
          eventId: `exception:${exception.id}`,
          institutionId: vault.institution_id,
          payload: {
            error: message,
            exceptionId: exception.id,
            kind: "unprocessable_transaction",
            signature,
            vault: vault.address,
          },
          type: "exception.created",
        });
      }
    });
    return true;
  }

  /** Signatures newer than `until` (exclusive) or at/after `floor`, newest first. */
  private async newerThan(
    address: string,
    bound: { until?: string; floor?: bigint }
  ): Promise<SignatureInfo[]> {
    const { floor, until } = bound;
    const collected: SignatureInfo[] = [];
    let before: string | undefined;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- pagination: each page starts before the previous page's last signature
      const page = await this.chain.getSignaturesForAddress(address, {
        before,
        limit: PAGE,
        until,
      });
      const kept =
        floor === undefined ? page : page.filter((info) => info.slot >= floor);
      collected.push(...kept);
      const last = page.at(-1);
      if (!last || page.length < PAGE || kept.length < page.length) {
        return collected;
      }
      before = last.signature;
    }
  }
}
