# Example: open AR by subsidiary (synthetic data)

**User:** What's our open AR by subsidiary?

**Agent:** calls `ns_suiteql`:

```sql
SELECT BUILTIN.DF(t.subsidiary) AS subsidiary,
       SUM(t.foreignamountunpaid) AS open_amount,
       COUNT(t.id) AS invoices
FROM transaction t
WHERE t.type = 'CustInvc'
  AND t.foreignamountunpaid > 0
GROUP BY BUILTIN.DF(t.subsidiary)
ORDER BY open_amount DESC
```

**Agent:** Open invoice balances by subsidiary (transaction currency, elimination subsidiaries excluded):

| Subsidiary | Open amount | Invoices |
| --- | --- | --- |
| Example Sub A | 120,400.00 | 38 |
| Example Sub B | 64,150.00 | 21 |

Amounts are in each invoice's own currency, so subsidiaries in different currencies are not directly comparable. Want them converted to a single currency?
