---
task_id: "003-good-input-validation"
label: good
ground_truth: APPROVE
bug: ""
rubric_criterion: ""
---

## Author rationale
Parse the request body with a zod schema at the edge so `limit` is bounded to 1..100 and coerced
to a number. Invalid input returns 400 before any DB work. The handler now receives typed, validated
data instead of `any`.

## Diff
```diff
--- a/src/pages/api/search.ts
+++ b/src/pages/api/search.ts
@@ -1,10 +1,16 @@
 import type { APIRoute } from "astro";
+import { z } from "zod";
+
+const Query = z.object({
+  q: z.string().min(1).max(200),
+  limit: z.coerce.number().int().min(1).max(100).default(20),
+});
 
 export const POST: APIRoute = async ({ request }) => {
-  const body = await request.json();
-  const results = await search(body.q, body.limit);
+  const parsed = Query.safeParse(await request.json());
+  if (!parsed.success) {
+    return new Response(JSON.stringify({ error: parsed.error.flatten() }), { status: 400 });
+  }
+  const results = await search(parsed.data.q, parsed.data.limit);
   return new Response(JSON.stringify(results), { status: 200 });
 };
```
