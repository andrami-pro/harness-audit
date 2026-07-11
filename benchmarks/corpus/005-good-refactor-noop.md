---
task_id: "005-good-refactor-noop"
label: good
ground_truth: APPROVE
bug: ""
rubric_criterion: ""
---

## Author rationale
Pure behavior-preserving refactor: extracted the repeated total calculation into a `subtotal`
helper and used it in both call sites. No logic change — same inputs produce the same outputs.
This exists to catch a reviewer that reflexively rejects (or rubber-stamps) any diff.

## Diff
```diff
--- a/src/lib/cart.ts
+++ b/src/lib/cart.ts
@@ -1,12 +1,12 @@
 export function cartSummary(items: Item[]) {
-  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
-  const withTax = items.reduce((s, i) => s + i.price * i.qty, 0) * 1.2;
-  return { total, withTax };
+  const total = subtotal(items);
+  return { total, withTax: total * 1.2 };
 }
+
+function subtotal(items: Item[]): number {
+  return items.reduce((s, i) => s + i.price * i.qty, 0);
+}
```
