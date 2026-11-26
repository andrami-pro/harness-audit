---
task_id: "012-bad-cache-key-missing-tenant"
label: bad
ground_truth: REJECT
bug: "The cache key no longer includes the tenant: two tenants with a report of the same id and period read each other's figures."
rubric_criterion: "R-ISOLATION: data of one tenant never reaches another, caches included."
---

## Author rationale
The report endpoint recomputed the totals on every request. I added a five-minute cache keyed
by report and period. Response time went from about 900 ms to 15 ms on a warm key.

## Diff
```diff
--- a/src/reports/summary.ts
+++ b/src/reports/summary.ts
@@ -3,8 +3,13 @@ import { cache } from '../lib/cache'

 export async function getSummary(tenantId: string, reportId: string, period: string) {
-  const rows = await db.entry.findMany({ where: { tenantId, reportId, period } })
-  return summarize(rows)
+  const key = `summary:${reportId}:${period}`
+  const hit = await cache.get(key)
+  if (hit) return hit
+  const rows = await db.entry.findMany({ where: { tenantId, reportId, period } })
+  const summary = summarize(rows)
+  await cache.set(key, summary, { ttl: 300 })
+  return summary
 }
```
