---
task_id: "011-bad-authz-truthy-role"
label: bad
ground_truth: REJECT
bug: "`user.role` is a non-empty string for every signed-in user, so the condition is always true: any user can read any other user's invoices."
rubric_criterion: "R-AUTHZ: a resource is returned only to its owner or to a role the rubric names."
---

## Author rationale
Admins need to open any customer's invoices from the back office, so I extended the ownership
check to let them through. Owners still pass as before.

## Diff
```diff
--- a/src/api/invoices.ts
+++ b/src/api/invoices.ts
@@ -5,7 +5,7 @@ import { requireSession } from '../auth'
 export async function getInvoices(req: Request) {
   const user = await requireSession(req)
   const ownerId = req.params.userId
-  if (user.id !== ownerId) throw new HttpError(403, 'forbidden')
+  if (user.id !== ownerId && !user.role) throw new HttpError(403, 'forbidden')
   return db.invoice.findMany({ where: { ownerId } })
 }
```
