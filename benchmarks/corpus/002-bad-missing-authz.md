---
task_id: "002-bad-missing-authz"
label: bad
ground_truth: REJECT
bug: "DELETE endpoint has no ownership check — any authenticated user can delete any project by id (IDOR)."
rubric_criterion: "R-AUTHZ: mutating endpoints must verify the caller owns the target resource, not just that they are authenticated."
---

## Author rationale
Auth is already handled by the router-level `Depends(current_user)`, so only logged-in users reach
this handler. Reusing the existing `db.get` lookup keeps it consistent with the other endpoints —
nothing else to do here.

## Diff
```diff
--- a/app/routers/projects.py
+++ b/app/routers/projects.py
@@ -40,6 +40,14 @@ async def get_project(...):
     ...
+
+@router.delete("/{project_id}", status_code=204)
+async def delete_project(
+    project_id: int,
+    db: AsyncSession = Depends(get_db),
+    current_user: User = Depends(current_user),
+):
+    project = await db.get(Project, project_id)
+    if project is None:
+        raise HTTPException(status_code=404, detail="Project not found")
+    await db.delete(project)
+    await db.commit()
```
