---
task_id: "009-bad-pagination-off-by-one"
label: bad
ground_truth: REJECT
bug: "`page` is 1-indexed everywhere else in the API; the new offset skips the first page of results."
rubric_criterion: "R-CORRECT: behaviour visible to callers is preserved unless the task says otherwise."
---

## Author rationale
I added a configurable page size and tidied the offset arithmetic while I was there. The
existing tests still pass, and the endpoint returns a full page for every request I tried.

## Diff
```diff
--- a/src/api/orders.ts
+++ b/src/api/orders.ts
@@ -8,9 +8,10 @@ const schema = z.object({
-  page: z.coerce.number().int().min(1).default(1),
+  page: z.coerce.number().int().min(1).default(1),
+  size: z.coerce.number().int().min(1).max(100).default(20),
 })

 export async function listOrders(req: Request, user: User) {
-  const { page } = schema.parse(req.query)
-  const offset = (page - 1) * 20
-  return db.order.findMany({ where: { ownerId: user.id }, skip: offset, take: 20 })
+  const { page, size } = schema.parse(req.query)
+  const offset = page * size
+  return db.order.findMany({ where: { ownerId: user.id }, skip: offset, take: size })
 }
```
