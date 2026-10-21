# Example: records that already exist (synthetic data)

**User:** Is contacts.csv ready to load?

**Agent:** plans, agrees `keyField: email`, and dry-runs. 120 rows: 112 valid; 8 are `exists-in-netsuite` because a contact with that email already exists.

**Agent:** 8 contacts already exist (lines 14, 27, ...). This tool only prepares new records; updating existing ones is not available. Remove those rows, or tell me if they should become updates when loading arrives in CP3. Nothing has been written to NetSuite.
