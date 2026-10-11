import { expect, test } from "bun:test";

import { statementCsv } from "./format";

test("statement CSV keeps chain context per posting and neutralises formulas", () => {
  const csv = statementCsv(
    {
      balanced: true,
      balances: [],
      exceptions: [],
      postings: [
        {
          account: "vault_cash",
          business_ref: '=HYPERLINK("x")',
          credit: "0",
          debit: "10000000000",
          entry: "fund_vault",
          id: "1",
          signature: "5sig",
          slot: "42",
        },
      ],
      reconciliation: { matches: true },
    },
    { network: "localnet", programId: "Prog", vault: "Vault1" }
  );
  const [header, row] = csv.trimEnd().split("\r\n");
  expect(header).toBe(
    '"network","program_id","vault","slot","entry","account","debit_base_units","credit_base_units","business_ref","signature"'
  );
  expect(row).toBe(
    '"localnet","Prog","Vault1","42","fund_vault","vault_cash","10000000000","0","\'=HYPERLINK(""x"")","5sig"'
  );
});
