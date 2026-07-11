---
task_id: "004-bad-sql-injection"
label: bad
ground_truth: REJECT
bug: "User-supplied `term` is f-string-interpolated into raw SQL — classic SQL injection."
rubric_criterion: "R-SEC: user input must never be concatenated/interpolated into SQL; use bound parameters."
---

## Author rationale
Switched to a raw query because the ORM's `ilike` was too slow on the big table. The `term` comes
from our own search box and we already strip whitespace upstream, so building the SQL with an
f-string is fine and much faster.

## Diff
```diff
--- a/app/services/search.py
+++ b/app/services/search.py
@@ -12,8 +12,9 @@ async def search_projects(term: str, db: AsyncSession) -> list[Project]:
-    stmt = select(Project).where(Project.name.ilike(f"%{term}%"))
-    return (await db.execute(stmt)).scalars().all()
+    sql = text(
+        f"SELECT * FROM projects WHERE name ILIKE '%{term}%' ORDER BY created_at DESC"
+    )
+    return (await db.execute(sql)).fetchall()
```
