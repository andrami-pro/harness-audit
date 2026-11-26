---
task_id: "010-bad-unawaited-writes"
label: bad
ground_truth: REJECT
bug: "`forEach` with an async callback does not wait: the handler answers `saved` before any write finishes, and a failed write is an unhandled rejection the caller never sees."
rubric_criterion: "R-CORRECT: a handler reports success only after the work it reports has finished."
---

## Author rationale
The import was slow because it saved rows one at a time with a for loop. I switched to forEach
so the saves start together. Much faster in my test with 500 rows, and the response is the same.

## Diff
```diff
--- a/src/import/contacts.ts
+++ b/src/import/contacts.ts
@@ -12,10 +12,9 @@ export async function importContacts(rows: ContactRow[], tenantId: string) {
   const valid = rows.filter(isValidContact)
-  for (const row of valid) {
-    await db.contact.upsert({ where: { email_tenantId: { email: row.email, tenantId } },
-      create: { ...row, tenantId }, update: row })
-  }
+  valid.forEach(async (row) => {
+    await db.contact.upsert({ where: { email_tenantId: { email: row.email, tenantId } },
+      create: { ...row, tenantId }, update: row })
+  })
   return { saved: valid.length, skipped: rows.length - valid.length }
 }
```
