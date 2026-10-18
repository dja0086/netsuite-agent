# Example: look up a record by name (synthetic data)

**User:** Pull up the customer Northwind.

**Agent:** calls `ns_global_search` with `keywords: "cu: northwind"` and gets two matches.

**Agent:** I found two customers matching "Northwind": *Northwind Traders* (id 1042) and *Northwind Labs* (id 2210). Which one?

**User:** Traders.

**Agent:** calls `ns_record_get` with `type: customer`, `id: "1042"`, `fields: [companyname, email, phone, subsidiary, balance, creditlimit]`, then summarises the record in a short table.
