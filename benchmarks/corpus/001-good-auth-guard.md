---
task_id: "001-good-auth-guard"
label: good
ground_truth: APPROVE
bug: ""
rubric_criterion: ""
---

## Author rationale
Added an explicit ownership check before returning the project: the query now filters by
`owner_id == current_user.id`, so a user can only read projects they own. Returns 404 (not 403)
to avoid leaking existence.

## Diff
```diff
--- a/app/routers/projects.py
+++ b/app/routers/projects.py
@@ -18,7 +18,10 @@ async def get_project(
     project_id: int,
     db: AsyncSession = Depends(get_db),
     current_user: User = Depends(current_user),
 ):
-    project = await db.get(Project, project_id)
-    if project is None:
+    stmt = select(Project).where(
+        Project.id == project_id, Project.owner_id == current_user.id
+    )
+    project = (await db.execute(stmt)).scalar_one_or_none()
+    if project is None:
         raise HTTPException(status_code=404, detail="Project not found")
     return project
```
