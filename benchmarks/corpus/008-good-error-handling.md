---
task_id: "008-good-error-handling"
label: good
ground_truth: APPROVE
bug: ""
rubric_criterion: ""
---

## Author rationale
Wrapped the outbound webhook call so a provider outage is logged with context and surfaced as a
retryable 502 instead of a bare 500 with a stack trace. The exception is re-raised as a domain error
(not swallowed), so the caller and monitoring still see the failure.

## Diff
```diff
--- a/app/services/notify.py
+++ b/app/services/notify.py
@@ -8,6 +8,15 @@ async def send_webhook(event: Event, url: str) -> None:
-    resp = await client.post(url, json=event.model_dump())
-    resp.raise_for_status()
+    try:
+        resp = await client.post(url, json=event.model_dump(), timeout=10.0)
+        resp.raise_for_status()
+    except httpx.HTTPError as exc:
+        logger.warning(
+            "webhook delivery failed", extra={"event_id": event.id, "url": url, "err": str(exc)}
+        )
+        raise WebhookDeliveryError(event.id) from exc
```
