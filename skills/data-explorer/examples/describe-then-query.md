# Example: describe before querying (synthetic data)

**User:** Which sales orders are flagged as rush?

**Agent:** calls `ns_record_describe` with `type: salesorder, customOnly: true` and finds `custbody_rush_order` (checkbox, label "Rush Order").

**Agent:** calls `ns_suiteql`:

```sql
SELECT t.tranid, BUILTIN.DF(t.entity) AS customer, t.trandate
FROM transaction t
WHERE t.type = 'SalesOrd' AND t.custbody_rush_order = 'T'
ORDER BY t.trandate DESC
```

**Agent:** 6 sales orders are flagged Rush Order (field `custbody_rush_order`). Here they are, newest first: ...

If the describe call had found no rush field, the agent would say so and ask what marks an order as rush, instead of guessing a field id.
