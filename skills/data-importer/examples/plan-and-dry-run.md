# Example: plan, agree the mapping, dry run (synthetic data)

**User:** Import customers.csv as new customers.

**Agent:** calls `ns_import_plan` with `file: customers.csv, recordType: customer`.

| Column | Field |
| --- | --- |
| External ID | externalId |
| Company Name | companyName |
| Email | email |
| Subsidiary | subsidiary |
| Currency | currency |
| Credit Limit | creditLimit |
| Start Date | startDate |
| Shoe Size | (no matching field) |

**Agent:** 4 rows. "Shoe Size" has no matching customer field, so I will leave it out. Required fields are all mapped. I will use External ID to find duplicates. OK?

**User:** Yes.

**Agent:** calls `ns_import_dry_run` with that mapping and `keyField: externalId`.

**Agent:** 1 of 4 rows is ready; 3 have problems (8 errors: 3 type, 2 reference, 1 format, 1 required, 1 duplicate):

- line 3: Email "not-an-email" is not an email address; Credit Limit "abc" is not a number; Start Date 2026-02-30 is not a real date
- line 4: Company Name is empty; Subsidiary "No Such Subsidiary" does not exist
- line 5: External ID repeats line 2; Currency "XYZ" does not exist; Start Date must be YYYY-MM-DD

All errors are in `exports/customers-dry-run-errors-20261021T034057Z.csv`. Fix the file and I will dry-run it again. Loading the rows into NetSuite is not available yet; nothing has been written.
