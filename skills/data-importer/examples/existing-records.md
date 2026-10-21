# Example: records that already exist (synthetic data)

**User:** Is contacts.csv ready to load?

**Agent:** plans, agrees `keyField: email`, and dry-runs. 120 rows: 112 valid; 8 are `exists-in-netsuite` because a contact with that email already exists.

**Agent:** 8 contacts already exist (lines 14, 27, ...). This tool only prepares new records; updating existing ones is not available. The importer only creates new records, so remove those rows and dry-run again. Nothing has been written to NetSuite.
