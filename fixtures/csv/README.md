# CSV fixtures

Fictional, seed-only CSV files used by the import tests (`src/modules/imports/__tests__/`) and by the
M2 e2e demo.

- `*-clean.csv`: one valid file per import template. Import them in this order: accounts, contacts,
  contracts, invoices, the three usage files, tickets, ticket messages. Importing any of them a
  second time creates nothing new.
- `accounts-malformed.csv`: every kind of problem the preview must report in plain words:
  - a missing name;
  - an unknown tier ("Platinum");
  - an unknown stage ("Sleeping");
  - a date that isn't a date ("31/13/2026");
  - an `account_id` repeated within the file;
  - an owner who isn't a member.
- `contacts-sample-fixed.csv`: the corrected version of `docs/samples/contacts-sample.csv`. The
  sample has one bad email address, which the demo fixes before importing.

## outside-signals-clean.csv (M3)

Public news about a customer (SEED_DATA §3: Brightwell acquired by Haverford Group, dated 2026-10-20).
Every row needs `source_url` and `event_date`; importing it again creates nothing.
