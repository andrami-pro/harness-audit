---
task_id: "007-bad-import-confinement"
label: bad
ground_truth: REJECT
bug: "A router reaches into another package's private internals (`atlas_agent._internal`) instead of its public API — breaks module confinement."
rubric_criterion: "R-CONFINE: app/ code must depend only on public interfaces; importing another package's `_internal`/private module is forbidden."
---

## Author rationale
The public client didn't expose the raw scoring function I needed, and I didn't want to wait for an
API change, so I imported the internal helper directly. It's the same codebase, so reaching into
`_internal` is a reasonable shortcut to unblock the feature.

## Diff
```diff
--- a/app/routers/insights.py
+++ b/app/routers/insights.py
@@ -1,6 +1,7 @@
 from fastapi import APIRouter, Depends
-from atlas_agent import AtlasClient
+from atlas_agent import AtlasClient
+from atlas_agent._internal.scoring import raw_relevance_score  # noqa: private
 
 router = APIRouter(prefix="/insights")
@@ -14,5 +15,5 @@ async def relevance(payload: Query):
-    return await client.score(payload.text)
+    return {"score": raw_relevance_score(payload.text, tune=0.7)}
```
