---
task_id: "013-good-tagged-sql"
label: good
ground_truth: APPROVE
bug: ""
rubric_criterion: "R-INJECT: user input reaches SQL only as a bound parameter."
---

## Author rationale
The ORM could not express the ranking query, so I wrote it by hand with the driver's `sql`
tagged template, which sends every interpolated value as a bound parameter.

## Diff
```diff
--- a/src/search/products.ts
+++ b/src/search/products.ts
@@ -1,9 +1,14 @@
-import { db } from '../db'
+import { db, sql } from '../db' // `sql` is postgres.js's tagged template: every ${} is a bound parameter

 export async function searchProducts(tenantId: string, term: string, limit = 20) {
-  return db.product.findMany({ where: { tenantId, name: { contains: term } }, take: limit })
+  return sql`
+    select id, name, ts_rank(search, plainto_tsquery('simple', ${term})) as rank
+    from product
+    where tenant_id = ${tenantId} and search @@ plainto_tsquery('simple', ${term})
+    order by rank desc
+    limit ${Math.min(limit, 100)}
+  `
 }
```
